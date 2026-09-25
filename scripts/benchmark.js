#!/usr/bin/env node
'use strict';

// Headless benchmark: every prompt case, both providers, one frozen probe set and mission set.
//
//   LAYA_URL=https://... LAYA_TOKEN=... JEV_KEY=... node scripts/benchmark.js [--providers laya,jev]
//     [--cases guided,facts,...] [--per-label 40] [--random 10] [--seed 7] [--latency-calls 100]
//     [--probes-only | --flights-only] [--env path/to/file.env] [--out benchmarks/results/<id>]
//
// Writes, per provider and case, every call (request state, raw answers, timing, attempts) to
// calls-<provider>-<case>.jsonl, plus summary.json and summary.md. Endpoint URLs and keys are
// never written.
const fs = require('node:fs');
const path = require('node:path');
const { runFlight, SCENARIOS: FIXED_SCENARIOS, randomScenarios } = require('../src/lander-sim');
const physics = require('../public/lander-physics');
const guidance = require('../public/lander-guidance');
const adapter = require('../public/lander-adapter');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };

// Optional env file (KEY=VALUE lines), so credentials never go on the command line.
const envFile = option('env');
if (envFile) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const { assess, verticalSentence, lateralSentence } = guidance;
const G = guidance.constants;

// ---- briefings (facts-only mode), exactly as measured earlier and as shipped in the app
const BRIEFINGS = {
  formula: 'Only brake when the distance needed to stop is larger than the altitude. Distance needed to stop is about (falling speed x falling speed) / 6 metres, plus 3 seconds of falling. Otherwise do not brake: coast or move sideways. Move sideways toward the pad; if the craft is close to the pad and moving fast toward it, push the other way to slow down.',
  intent: 'Do not brake while high up. Let the craft fall and only brake near the ground. Use sideways burns to get over the pad early.',
  braking_table: 'Braking rule: falling 5 m/s, brake below 25 m altitude. Falling 10 m/s, brake below 60 m. Falling 15 m/s, brake below 110 m. Falling 20 m/s, brake below 170 m. Falling faster than 22 m/s, always brake. Above those altitudes do not brake. Sideways: accelerate toward the pad until moving about 10 m/s toward it; when less than 100 m from the pad and moving faster than 5 m/s toward it, accelerate away from the pad.',
  flight_rules: 'Default: no burn. Brake if altitude is below 50 m, or below this altitude for the falling speed: 10 m/s: 90 m. 15 m/s: 150 m. 20 m/s: 220 m. Over 20 m/s: always. Sideways target speed toward the pad: pad over 200 m away: 12 m/s. 100 m: 10. 50 m: 6. 20 m: 2. Below the craft: 0. Accelerate toward the pad only if slower than target by more than 2 m/s, or moving away. Accelerate away from the pad only if faster than target by more than 2 m/s. Otherwise no sideways burn.'
};

const noulOf = (answers, key) => adapter.noulScore(answers?.[key]);
const toControl = { push_left: 'left_thrust', push_right: 'right_thrust', hold: 'coast' };

// ---- prompt cases. Each builds one request body (state + questions) and parses answers to a control.
const CASES = {
  // Original approach: raw telemetry JSON, one 4-way choice (adapter variant `numeric`).
  numeric: { label: 'Raw telemetry, one 4-way choice', build: (t) => adapter.VARIANTS.numeric.build(t), parse: (a) => adapter.VARIANTS.numeric.parse(a) },
  // Reconstructed: guided sentences with one 4-way choice (the variant was removed from the app).
  guided_choice4: {
    label: 'Guided sentences, one 4-way choice (reconstructed)',
    build(t) { const a = assess(t); return { state: { vertical_situation: verticalSentence(a), sideways_situation: lateralSentence(a) }, questions: { flight_control: { type: 'choice', instructions: 'Based on the vertical and sideways situation, choose exactly one control for the next 0.48 seconds.', criteria: adapter.CRITERIA } } }; },
    parse: (a) => a?.flight_control?.choice
  },
  // Reconstructed: brake yes/no plus one 3-way sideways choice.
  guided_brake_choice: {
    label: 'Guided sentences, brake yes/no + sideways choice (reconstructed)',
    build(t) {
      const a = assess(t);
      return { state: { vertical_situation: verticalSentence(a), sideways_situation: lateralSentence(a) }, questions: {
        brake: { type: 'noul', instructions: 'Based on the vertical situation, must the engine brake right now to slow the descent?' },
        sideways: { type: 'choice', instructions: 'Based on the sideways situation, which sideways correction is needed?', criteria: { push_left: 'Accelerate to the LEFT.', push_right: 'Accelerate to the RIGHT.', hold: 'No sideways correction is needed.' } }
      } };
    },
    parse(a) { const brake = noulOf(a, 'brake'); if (typeof brake !== 'number') return undefined; return brake >= adapter.THRESHOLDS.brake ? 'thrust' : toControl[a?.sideways?.choice]; }
  },
  // The app's default: guided sentences, three yes/no questions.
  guided: { label: 'Guided sentences, three yes/no', build: (t) => adapter.VARIANTS.binary.build(t), parse: (a) => adapter.VARIANTS.binary.parse(a) },
  // Middle ground (new): the flight director's numbers and the rule, but no verdict.
  computed: { label: 'Computed numbers + rule, no verdict (new)', build: (t) => computedRequest(t), parse: (a) => adapter.VARIANTS.binary.parse(a) },
  // Facts only, with and without briefings.
  facts: { label: 'Facts only', build: (t) => adapter.VARIANTS.facts.build(t), parse: (a) => adapter.VARIANTS.binary.parse(a) },
  ...Object.fromEntries(Object.entries(BRIEFINGS).map(([key, text]) => [`facts_${key}`, {
    label: `Facts only + ${key.replace('_', ' ')} briefing`, briefing: text,
    build: (t) => adapter.buildRequests(t, 'facts', undefined, { briefing: text })[0], parse: (a) => adapter.VARIANTS.binary.parse(a)
  }]))
};
// Strip any model field: the provider transport sets it.
for (const c of Object.values(CASES)) { const build = c.build; c.build = (t) => { const { model, ...body } = build(t); return body; }; }

// Middle-ground text: every number the flight director uses, with the comparison rule stated,
// and none of its conclusions ("must brake", "required", "too fast").
function computedRequest(t) {
  const a = assess(t), r = (v) => Math.round(Math.abs(v));
  const alt = Math.max(0, a.alt), vy = a.vy;
  const approachSpeed = Math.max(2, a.off < 0 ? a.vx : -a.vx);
  const timeToPad = a.distance / approachSpeed, timeToLow = Math.max(0, alt - G.LOW_ALTITUDE) / Math.max(vy, .5);
  const vertical = [
    `Altitude remaining: ${r(alt)} m.`,
    vy >= 0 ? `Falling at ${vy.toFixed(1)} m/s.` : `Rising at ${Math.abs(vy).toFixed(1)} m/s.`,
    `Distance needed to stop, including the delay before the next decision: ${r(a.stoppingDistance)} m.`,
    `Descent speed limit: ${G.MAX_DESCENT} m/s.`,
    `Distance to the pad: ${r(a.distance)} m. Time to reach ${G.LOW_ALTITUDE} m altitude at this descent rate: ${timeToLow.toFixed(0)} s. Time to reach the pad at the current sideways speed: ${timeToPad.toFixed(0)} s.`
  ].join(' ');
  const side = a.padSide.toUpperCase(), toward = a.targetVx === 0 ? 0 : a.targetVx;
  const velocity = (v) => Math.abs(v) < .05 ? 'none' : `${Math.abs(v).toFixed(1)} m/s to the ${v > 0 ? 'RIGHT' : 'LEFT'}`;
  const sideways = [
    a.distance < 5 ? 'The pad is directly below the craft.' : `The pad is ${r(a.distance)} m to the ${side}.`,
    `Current sideways velocity: ${velocity(a.vx)}.`,
    `Target sideways velocity for this distance: ${velocity(toward)}.`,
    `Allowed difference before a correction: ${alt < 80 ? '1.0' : '1.5'} m/s. Altitude: ${r(alt)} m; below ${G.FINAL_DESCENT_ALTITUDE} m no sideways burns are allowed.`
  ].join(' ');
  return {
    state: { vertical_numbers: vertical, sideways_numbers: sideways },
    questions: {
      brake: { type: 'noul', instructions: `Using these numbers: brake is needed if the distance needed to stop is more than the altitude remaining minus 5 m, or the descent speed is above the limit, or the craft is more than ${G.FAR_FROM_PAD} m from the pad, falling faster than ${G.FAR_DESCENT} m/s, and would reach ${G.LOW_ALTITUDE} m altitude before reaching the pad. Is braking needed right now?` },
      go_right: { type: 'noul', instructions: 'Using these numbers: should the craft accelerate to the RIGHT? It should if the target velocity is further to the right than the current velocity by more than the allowed difference, and the craft is not below the no-sideways-burn altitude.' },
      go_left: { type: 'noul', instructions: 'Using these numbers: should the craft accelerate to the LEFT? It should if the target velocity is further to the left than the current velocity by more than the allowed difference, and the craft is not below the no-sideways-burn altitude.' }
    }
  };
}

// ---- providers and transport
const PROVIDERS = {
  laya: { connection: () => ({ provider: 'laya', baseUrl: process.env.LAYA_URL, token: process.env.LAYA_TOKEN, model: process.env.LAYA_MODEL || 'english' }), ready: () => process.env.LAYA_URL && process.env.LAYA_TOKEN, concurrency: 4 },
  jev: { connection: () => ({ provider: 'jev', token: process.env.JEV_KEY }), ready: () => process.env.JEV_KEY, concurrency: 8 }
};

async function call(providerName, body) {
  const connection = PROVIDERS[providerName].connection(), provider = adapter.PROVIDERS[providerName];
  const url = provider.url(connection), payload = provider.body({ ...body, model: undefined }, connection);
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const started = performance.now();
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...provider.headers(connection.token) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
      const text = await response.text(), clientMs = performance.now() - started;
      if (!response.ok) { lastError = `HTTP ${response.status}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`; await sleep((response.status === 429 ? 3000 : 600) * attempt); continue; }
      const json = JSON.parse(text);
      return { ok: true, attempts: attempt, clientMs, json };
    } catch (error) { lastError = error.name === 'TimeoutError' ? 'timeout' : error.message; await sleep(600 * attempt); }
  }
  return { ok: false, attempts: 4, error: lastError };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, concurrency, worker) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (next < items.length) { const i = next++; results[i] = await worker(items[i], i); } }));
  return results;
}

// ---- frozen probe set and missions
const PER_LABEL = Number(option('per-label', 40));
const SEED = Number(option('seed', 7));
const SCENARIOS = [...FIXED_SCENARIOS, ...randomScenarios(Number(option('random', 10)), SEED)].slice(0, Number(option('max-scenarios', 1e9)));
const LATENCIES = [150, 300];

async function buildProbes() {
  const byLabel = {};
  for (const scenario of SCENARIOS) for (const latencyMs of LATENCIES) {
    const flight = await runFlight({ ship: scenario.ship, padCenter: scenario.padCenter, latencyMs, policy: (t) => ({ choice: assess(t).recommended, meta: t }) });
    for (const entry of flight.log) {
      const a = assess(entry.meta);
      (byLabel[a.recommended] ||= []).push({ scenario: scenario.name, latencyMs, telemetry: entry.meta, expected: a.recommended, reason: a.brakeReason || a.lateralReason, expectedAnswers: { brake: a.mustBrake, go_right: a.lateralNeed === 'push_right', go_left: a.lateralNeed === 'push_left' } });
    }
  }
  const probes = [];
  for (const label of physics.CONTROLS) {
    const list = byLabel[label] || [], stride = Math.max(1, list.length / PER_LABEL);
    for (let i = 0, n = 0; i < list.length && n < PER_LABEL; i += stride, n++) probes.push({ id: probes.length, ...list[Math.floor(i)] });
  }
  return probes;
}

// ---- runs
function record(stream, entry) { stream.write(`${JSON.stringify(entry)}\n`); }
function meta(json) { return { model: json?.model || json?.routing?.model, repo: json?.routing?.repo, device: json?.routing?.device, serverMs: json?.timing?.inference_ms, serverTotalMs: json?.timing?.total_ms }; }

async function runProbes(providerName, caseName, probes, stream) {
  const spec = CASES[caseName];
  return pool(probes, PROVIDERS[providerName].concurrency, async (probe) => {
    const body = spec.build(probe.telemetry), res = await call(providerName, body);
    const answers = res.ok ? res.json.answers || {} : null;
    let got = res.ok ? spec.parse(answers) : 'error';
    if (res.ok && !physics.CONTROLS.includes(got)) got = 'invalid';
    const entry = { kind: 'probe', provider: providerName, case: caseName, probe: probe.id, scenario: probe.scenario, reason: probe.reason, expected: probe.expected, expectedAnswers: probe.expectedAnswers, got, correct: got === probe.expected, telemetry: brief(probe.telemetry), state: body.state, answers, attempts: res.attempts, clientMs: round(res.clientMs), error: res.error, ...(res.ok ? meta(res.json) : {}) };
    record(stream, entry);
    return entry;
  });
}

async function runFlights(providerName, caseName, stream) {
  const spec = CASES[caseName];
  const jobs = SCENARIOS.flatMap((scenario) => LATENCIES.map((latencyMs) => ({ scenario, latencyMs })));
  return pool(jobs, PROVIDERS[providerName].concurrency, async ({ scenario, latencyMs }) => {
    let calls = 0, agree = 0, error = null, retries = 0;
    const flightId = `${scenario.name}@${latencyMs}`;
    try {
      const flight = await runFlight({ ship: scenario.ship, padCenter: scenario.padCenter, latencyMs, policy: async (t) => {
        const body = spec.build(t), res = await call(providerName, body);
        calls++; retries += (res.attempts || 1) - 1;
        if (!res.ok) throw new Error(`call failed: ${res.error}`);
        const choice = spec.parse(res.json.answers || {}), plan = assess(t).recommended;
        record(stream, { kind: 'flight_decision', provider: providerName, case: caseName, flight: flightId, n: calls, telemetry: brief(t), plan, got: choice, answers: res.json.answers, attempts: res.attempts, clientMs: round(res.clientMs), ...meta(res.json) });
        if (!physics.CONTROLS.includes(choice)) throw new Error(`invalid answer: ${JSON.stringify(res.json.answers).slice(0, 160)}`);
        agree += choice === plan;
        return choice;
      } });
      const outcome = flight.timedOut ? 'timed_out' : flight.outcome;
      const entry = { kind: 'flight', provider: providerName, case: caseName, flight: flightId, scenario: scenario.name, latencyMs, outcome, landed: flight.landed, padOffset: round(flight.padOffset, 1), vx: round(flight.vx, 2), vy: round(flight.vy, 2), tilt: round(flight.a, 3), fuel: round(flight.fuel, 1), decisions: flight.decisions, agreement: round(agree / Math.max(1, calls), 3), counts: flight.counts, retries };
      record(stream, entry); return entry;
    } catch (e) { error = e.message; }
    const entry = { kind: 'flight', provider: providerName, case: caseName, flight: flightId, scenario: scenario.name, latencyMs, outcome: 'error', landed: false, error, decisions: calls, retries };
    record(stream, entry); return entry;
  });
}

// Sequential round-trip latency on one fixed guided request, after warm-up.
async function runLatency(providerName, n, stream) {
  const body = CASES.guided.build(physics.telemetry(physics.makeTerrain(), physics.createShip()));
  for (let i = 0; i < 5; i++) await call(providerName, body);
  const out = [];
  for (let i = 0; i < n; i++) {
    const res = await call(providerName, body);
    const entry = { kind: 'latency', provider: providerName, i, ok: res.ok, attempts: res.attempts, clientMs: round(res.clientMs), error: res.error, ...(res.ok ? meta(res.json) : {}) };
    record(stream, entry); out.push(entry);
  }
  return out;
}

const round = (v, d = 1) => (typeof v === 'number' ? +v.toFixed(d) : v);
const brief = (t) => ({ altitude: round(t.altitude), verticalVelocity: round(t.verticalVelocity, 2), horizontalVelocity: round(t.horizontalVelocity, 2), padOffset: round(t.padOffset), fuel: round(t.fuel) });

// ---- statistics
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
function pct(values, p) { const s = values.filter((v) => typeof v === 'number').sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.round((s.length - 1) * p))] : null; }
const mean = (values) => { const v = values.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

function summarizeProbes(results) {
  const valid = results.filter((r) => r.got !== 'error'), correct = valid.filter((r) => r.correct).length;
  const confusion = {}, byReason = {}, scores = {};
  for (const r of valid) {
    (confusion[r.expected] ||= {})[r.got] = (confusion[r.expected][r.got] || 0) + 1;
    const br = (byReason[r.reason] ||= { n: 0, ok: 0 }); br.n++; br.ok += r.correct;
    for (const [q, yes] of Object.entries(r.expectedAnswers)) {
      const s = adapter.noulScore(r.answers?.[q]); if (typeof s !== 'number') continue;
      const bucket = ((scores[q] ||= { yes: [], no: [] })[yes ? 'yes' : 'no']); bucket.push(s);
    }
  }
  const scoreStats = Object.fromEntries(Object.entries(scores).map(([q, b]) => [q, { whenYes: { n: b.yes.length, mean: round(mean(b.yes), 3), aboveThreshold: b.yes.filter((s) => s >= .5).length }, whenNo: { n: b.no.length, mean: round(mean(b.no), 3), aboveThreshold: b.no.filter((s) => s >= .5).length } }]));
  const [lo, hi] = wilson(correct, valid.length);
  return { total: results.length, errors: results.length - valid.length, invalid: valid.filter((r) => r.got === 'invalid').length, correct, accuracy: round(correct / Math.max(1, valid.length), 4), ci95: [round(lo, 4), round(hi, 4)], confusion, byReason, scoreStats };
}
function summarizeFlights(flights) {
  const landed = flights.filter((f) => f.landed), by = (o) => flights.filter((f) => f.outcome === o).length;
  const [lo, hi] = wilson(landed.length, flights.length);
  const counts = {}; for (const f of flights) for (const [k, v] of Object.entries(f.counts || {})) counts[k] = (counts[k] || 0) + v;
  return { total: flights.length, landed: landed.length, ci95: [round(lo, 4), round(hi, 4)], offPad: by('off_pad'), crashed: by('crashed'), timedOut: by('timed_out'), errors: by('error'), fixedLanded: landed.filter((f) => !f.scenario.startsWith('random')).length, fixedTotal: flights.filter((f) => !f.scenario.startsWith('random')).length, meanTouchdownVy: round(mean(landed.map((f) => Math.abs(f.vy))), 2), meanMissLanded: round(mean(landed.map((f) => Math.abs(f.padOffset))), 1), meanFuelLanded: round(mean(landed.map((f) => f.fuel)), 1), meanAgreement: round(mean(flights.map((f) => f.agreement)), 3), decisions: flights.reduce((a, f) => a + (f.decisions || 0), 0), actionMix: counts, retries: flights.reduce((a, f) => a + (f.retries || 0), 0) };
}
function summarizeCalls(entries) {
  const ok = entries.filter((e) => typeof e.clientMs === 'number');
  const models = {}; for (const e of ok) { const k = e.model || '?'; models[k] = (models[k] || 0) + 1; }
  return { calls: entries.length, clientP50: round(pct(ok.map((e) => e.clientMs), .5)), clientP95: round(pct(ok.map((e) => e.clientMs), .95)), serverP50: round(pct(ok.map((e) => e.serverMs), .5)), serverP95: round(pct(ok.map((e) => e.serverMs), .95)), retries: entries.reduce((a, e) => a + ((e.attempts || 1) - 1), 0), models, repos: [...new Set(ok.map((e) => e.repo).filter(Boolean))], devices: [...new Set(ok.map((e) => e.device).filter(Boolean))] };
}

// ---- main
(async () => {
  const providers = option('providers', 'laya,jev').split(',').filter((p) => PROVIDERS[p]?.ready() || (console.error(`skip ${p}: credentials not set`), false));
  if (!providers.length) { console.error('No provider credentials. Set LAYA_URL + LAYA_TOKEN and/or JEV_KEY (or pass --env file).'); process.exit(2); }
  const caseNames = option('cases', Object.keys(CASES).join(',')).split(',');
  for (const c of caseNames) if (!CASES[c]) throw new Error(`Unknown case ${c}. Known: ${Object.keys(CASES).join(', ')}`);
  const started = new Date(), runId = started.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = option('out', path.join(__dirname, '..', 'benchmarks', 'results', runId));
  fs.mkdirSync(outDir, { recursive: true });

  const probes = await buildProbes();
  fs.writeFileSync(path.join(outDir, 'probes.json'), JSON.stringify(probes.map((p) => ({ id: p.id, scenario: p.scenario, latencyMs: p.latencyMs, expected: p.expected, reason: p.reason, telemetry: p.telemetry })), null, 1));
  fs.writeFileSync(path.join(outDir, 'scenarios.json'), JSON.stringify(SCENARIOS, null, 1));
  const summary = { runId, startedAt: started.toISOString(), node: process.version, perLabel: PER_LABEL, seed: SEED, scenarios: SCENARIOS.length, latencies: LATENCIES, probes: probes.length, thresholds: adapter.THRESHOLDS, cases: Object.fromEntries(caseNames.map((c) => [c, { label: CASES[c].label, briefing: CASES[c].briefing || null }])), results: {} };
  const save = () => fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`run ${runId}: ${probes.length} probes, ${SCENARIOS.length * LATENCIES.length} flights per case, providers ${providers.join(', ')}, cases ${caseNames.join(', ')}\n-> ${outDir}`);

  // Providers run in parallel (different backends); cases run one after another per provider.
  await Promise.all(providers.map(async (providerName) => {
    const result = summary.results[providerName] = {};
    const latencyCalls = Number(option('latency-calls', 100));
    if (latencyCalls > 0 && !flag('no-latency')) {
      const stream = fs.createWriteStream(path.join(outDir, `calls-${providerName}-latency.jsonl`));
      const entries = await runLatency(providerName, latencyCalls, stream); stream.end();
      result.latency = { ...summarizeCalls(entries), failed: entries.filter((e) => !e.ok).length };
      console.log(`[${providerName}] latency: client p50 ${result.latency.clientP50} ms, p95 ${result.latency.clientP95} ms${result.latency.serverP50 != null ? `, server p50 ${result.latency.serverP50} ms` : ''}`);
      save();
    }
    for (const caseName of caseNames) {
      const t0 = Date.now(), stream = fs.createWriteStream(path.join(outDir, `calls-${providerName}-${caseName}.jsonl`));
      const out = result[caseName] = {};
      if (!flag('flights-only')) out.probes = summarizeProbes(await runProbes(providerName, caseName, probes, stream));
      if (!flag('probes-only')) out.flights = summarizeFlights(await runFlights(providerName, caseName, stream));
      stream.end(); await new Promise((r) => stream.on('finish', r));
      const entries = fs.readFileSync(path.join(outDir, `calls-${providerName}-${caseName}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind !== 'flight');
      out.calls = summarizeCalls(entries); out.seconds = Math.round((Date.now() - t0) / 1000);
      save();
      console.log(`[${providerName}/${caseName}] ${out.probes ? `decisions ${out.probes.correct}/${out.probes.total - out.probes.errors}` : ''}${out.flights ? ` landings ${out.flights.landed}/${out.flights.total} (crash ${out.flights.crashed}, off-pad ${out.flights.offPad}, timeout ${out.flights.timedOut}, error ${out.flights.errors})` : ''} ${out.seconds}s`);
    }
  }));
  summary.finishedAt = new Date().toISOString(); save();
  fs.writeFileSync(path.join(outDir, 'summary.md'), markdown(summary));
  console.log(`\nsummary: ${path.join(outDir, 'summary.md')}`);
})().catch((error) => { console.error(error); process.exit(1); });

function markdown(s) {
  const P = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const lines = [`# Moon lander benchmark ${s.runId}`, '', `Started ${s.startedAt}, finished ${s.finishedAt}. ${s.probes} decision probes (up to ${s.perLabel} per control), ${s.scenarios} missions × ${s.latencies.join('/')} ms = ${s.scenarios * s.latencies.length} flights per case. Seed ${s.seed}. Threshold 0.5.`, ''];
  for (const [provider, r] of Object.entries(s.results)) {
    lines.push(`## ${provider}`, '');
    if (r.latency) lines.push(`Latency (${r.latency.calls} sequential guided calls after warm-up): client p50 ${r.latency.clientP50} ms, p95 ${r.latency.clientP95} ms${r.latency.serverP50 != null ? `; server inference p50 ${r.latency.serverP50} ms, p95 ${r.latency.serverP95} ms` : ''}. Models: ${JSON.stringify(r.latency.models)}${r.latency.devices.length ? `, device ${r.latency.devices.join(',')}` : ''}. Failed: ${r.latency.failed}.`, '');
    lines.push('| Case | Decisions | 95% CI | Landings | 95% CI | Crash / off-pad / timeout / error | Mean touchdown vy | Retries |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [c, v] of Object.entries(r)) {
      if (c === 'latency') continue;
      const p = v.probes, f = v.flights;
      lines.push(`| ${s.cases[c].label} | ${p ? `${p.correct}/${p.total - p.errors} (${P(p.accuracy)})` : '—'} | ${p ? `${P(p.ci95[0])}–${P(p.ci95[1])}` : '—'} | ${f ? `${f.landed}/${f.total}` : '—'} | ${f ? `${P(f.ci95[0])}–${P(f.ci95[1])}` : '—'} | ${f ? `${f.crashed} / ${f.offPad} / ${f.timedOut} / ${f.errors}` : '—'} | ${f?.meanTouchdownVy ?? '—'} | ${v.calls.retries} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
