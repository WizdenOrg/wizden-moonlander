#!/usr/bin/env node
'use strict';

// Live evaluation of Laya as the lander pilot.
//
//   LAYA_URL=https://... LAYA_TOKEN=... node scripts/lander-eval.js [--variants decomposed,situational] [--probes-only|--flights-only] [--latency 150,300] [--per-label 30]
//
// 1. Decision probes: flight states sampled from reference-controller flights, labelled with the
//    control the reference plan chooses. Measures Laya's per-decision accuracy and confusion.
// 2. Closed-loop flights: Laya flies every launch scenario in the headless simulator.
const fs = require('node:fs');
const path = require('node:path');
const { runFlight, SCENARIOS: FIXED_SCENARIOS, randomScenarios } = require('../src/lander-sim');
const { assess } = require('../src/lander-guidance');
const { buildRequests, decide, VARIANTS, DEFAULT_VARIANT } = require('../src/lander-adapter');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const provider = option('provider', 'laya');
const briefing = option('briefing', '');
const baseUrl = String(process.env.LAYA_URL || '').replace(/\/$/, '');
const token = provider === 'jev' ? process.env.JEV_KEY : process.env.LAYA_TOKEN;
if (provider === 'jev' ? !token : !(baseUrl && token)) { console.error(provider === 'jev' ? 'Set JEV_KEY.' : 'Set LAYA_URL and LAYA_TOKEN.'); process.exit(2); }
const variants = option('variants', DEFAULT_VARIANT).split(',');
const latencies = option('latency', '150,300').split(',').map(Number);
const perLabel = Number(option('per-label', 30));
const concurrency = Number(option('concurrency', 6));
const model = option('model', 'english');
const SCENARIOS = [...FIXED_SCENARIOS, ...randomScenarios(Number(option('random', 0)), Number(option('seed', 7)))];

async function layaDecide(telemetry, variant) {
  const connection = provider === 'jev' ? { provider, token, variant } : { provider, baseUrl, token, variant, model };
  for (let attempt = 0; ; attempt++) {
    try {
      const { choice, rawProviderOutput } = await decide(telemetry, connection, { briefing });
      return { choice, raw: rawProviderOutput };
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function pool(items, worker) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => { while (next < items.length) { const i = next++; results[i] = await worker(items[i], i); } }));
  return results;
}

// Deterministic probe set drawn from reference flights across every scenario and latency.
async function buildProbes() {
  const byLabel = {};
  for (const scenario of SCENARIOS) for (const latencyMs of [150, 300]) {
    const flight = await runFlight({ ship: scenario.ship, padCenter: scenario.padCenter, latencyMs, policy: (t) => ({ choice: assess(t).recommended, meta: t }) });
    for (const entry of flight.log) {
      const a = assess(entry.meta);
      (byLabel[a.recommended] ||= []).push({ scenario: scenario.name, telemetry: entry.meta, expected: a.recommended, reason: a.brakeReason || a.lateralReason });
    }
  }
  const probes = [];
  for (const [label, list] of Object.entries(byLabel)) {
    const stride = Math.max(1, list.length / perLabel);
    for (let i = 0; i < list.length && probes.filter((p) => p.expected === label).length < perLabel; i += stride) probes.push(list[Math.floor(i)]);
  }
  return probes;
}

async function evalProbes(variant, probes) {
  const results = await pool(probes, async (probe) => ({ ...probe, got: (await layaDecide(probe.telemetry, variant)).choice }));
  const confusion = {}, byReason = {};
  for (const r of results) {
    confusion[r.expected] ||= {}; confusion[r.expected][r.got] = (confusion[r.expected][r.got] || 0) + 1;
    byReason[r.reason] ||= { n: 0, ok: 0 }; byReason[r.reason].n++; byReason[r.reason].ok += r.got === r.expected;
  }
  const correct = results.filter((r) => r.got === r.expected).length;
  return { accuracy: correct / results.length, correct, total: results.length, confusion, byReason, misses: results.filter((r) => r.got !== r.expected).map((r) => ({ expected: r.expected, got: r.got, reason: r.reason, request: buildRequests(r.telemetry, variant).map((b) => b.state) })) };
}

async function evalFlights(variant) {
  const jobs = SCENARIOS.flatMap((scenario) => latencies.map((latencyMs) => ({ scenario, latencyMs })));
  return pool(jobs, async ({ scenario, latencyMs }) => {
    let agree = 0, calls = 0;
    const flight = await runFlight({ ship: scenario.ship, padCenter: scenario.padCenter, latencyMs, policy: async (t) => { const { choice } = await layaDecide(t, variant); calls++; agree += choice === assess(t).recommended; return choice; } });
    return { scenario: scenario.name, latencyMs, landed: flight.landed, timedOut: flight.timedOut, padOffset: +flight.padOffset.toFixed(1), vx: +flight.vx.toFixed(2), vy: +flight.vy.toFixed(2), fuel: +flight.fuel.toFixed(1), decisions: flight.decisions, agreement: +(agree / Math.max(1, calls)).toFixed(3), counts: flight.counts };
  });
}

(async () => {
  const report = { at: new Date().toISOString(), provider, briefing, baseUrl: provider === 'jev' ? 'typesafe' : baseUrl.replace(/\/\/([^.]+)/, '//***'), model, variants: {} };
  const probes = flag('flights-only') ? null : await buildProbes();
  for (const variant of variants) {
    if (!VARIANTS[variant]) throw new Error(`Unknown variant ${variant}`);
    const out = report.variants[variant] = {};
    if (probes) {
      out.probes = await evalProbes(variant, probes);
      console.log(`\n[${provider}/${variant}] probe accuracy ${(out.probes.accuracy * 100).toFixed(1)}% (${out.probes.correct}/${out.probes.total})`);
      for (const [expected, row] of Object.entries(out.probes.confusion)) console.log(`  expected ${expected.padEnd(13)} -> ${JSON.stringify(row)}`);
      for (const [reason, v] of Object.entries(out.probes.byReason)) console.log(`  ${reason.padEnd(22)} ${v.ok}/${v.n}`);
    }
    if (!flag('probes-only')) {
      out.flights = await evalFlights(variant);
      const landed = out.flights.filter((f) => f.landed).length;
      console.log(`\n[${provider}/${variant}] landings ${landed}/${out.flights.length}`);
      for (const f of out.flights) console.log(`  ${f.landed ? 'LAND ' : f.timedOut ? 'TIME ' : 'CRASH'} ${f.scenario.padEnd(34)} ${String(f.latencyMs).padStart(3)}ms off ${String(f.padOffset).padStart(7)} vx ${String(f.vx).padStart(6)} vy ${String(f.vy).padStart(6)} fuel ${String(f.fuel).padStart(5)} agree ${f.agreement} ${JSON.stringify(f.counts)}`);
    }
  }
  const dir = path.join(__dirname, '..', 'eval-results'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `lander-eval-${Date.now()}.json`); fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nreport: ${path.relative(process.cwd(), file)}`);
})().catch((error) => { console.error(error); process.exit(1); });
