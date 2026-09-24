'use strict';

// Offline lander suite: flight model, flight-director guidance, Laya request/answer contract,
// and closed-loop flights through the real adapter against a fake Laya endpoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const physics = require('../public/lander-physics');
const { runFlight, SCENARIOS, randomScenarios } = require('../src/lander-sim');
const { assess, lateralSentence, verticalSentence } = require('../src/lander-guidance');
const { buildRequests, choiceFrom, decide } = require('../src/lander-adapter');
const { server } = require('../server');

const reference = (t) => assess(t).recommended;
const terrain = physics.makeTerrain();
const telemetryFor = (ship, padCenter) => physics.telemetry(padCenter ? physics.makeTerrain(padCenter) : terrain, physics.createShip(ship));

// Stand-in for Laya that reads the situation text the way the live model is expected to.
function fakeLayaAnswers(body) {
  const text = JSON.stringify(body.state);
  const answers = {};
  for (const [key, question] of Object.entries(body.questions)) {
    const yes = key === 'brake' ? /must brake now/.test(text) : key === 'go_right' ? /accelerate to the RIGHT/.test(text) : key === 'go_left' ? /accelerate to the LEFT/.test(text) : false;
    answers[key] = question.type === 'noul' ? { type: 'noul', noul: yes ? .85 : .2 } : { type: 'choice', choice: Object.keys(question.criteria)[0] };
  }
  return { answers };
}
let fakeLaya, fakeUrl, relayUrl;
test.before(async () => {
  fakeLaya = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fakeLayaAnswers(JSON.parse(raw)))); }); });
  await new Promise((resolve) => fakeLaya.listen(0, resolve)); fakeUrl = `http://127.0.0.1:${fakeLaya.address().port}`;
  await new Promise((resolve) => server.listen(0, resolve)); relayUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => fakeLaya.close(r)); await new Promise((r) => server.close(r)); });

test('autopilot maneuvers hold attitude: translation burns tilt toward their side and brake stays upright', () => {
  for (const [command, sign] of [['left_thrust', -1], ['right_thrust', 1], ['thrust', 0], ['coast', 0]]) {
    const ship = physics.createShip({ a: .3 * (sign || 1), vx: 0 });
    for (let i = 0; i < 60; i++) physics.integrate(terrain, ship, physics.controlsFor(command), 16);
    assert.ok(Math.abs(ship.a - sign * physics.MANEUVER_TILT) < .01, `${command} settles at its target tilt`);
  }
  const ship = physics.createShip({ a: 0 });
  for (let i = 0; i < 40; i++) physics.integrate(terrain, ship, physics.controlsFor('right_thrust'), 16);
  assert.ok(ship.vx > 2, 'right_thrust accelerates the craft to the right');
});

test('brake burns lean against sideways drift within the safe touchdown tilt', () => {
  const ship = physics.createShip({ vx: 4, vy: 10 });
  for (let i = 0; i < 200; i++) { physics.integrate(terrain, ship, physics.controlsFor('thrust'), 16); assert.ok(Math.abs(ship.a) < physics.SAFE_TILT); }
  assert.ok(Math.abs(ship.vx) < 1, `drift nulled (${ship.vx.toFixed(2)})`);
});

test('brake burns never push the craft into a climb', () => {
  const ship = physics.createShip({ vy: 12 });
  let minVy = Infinity;
  for (let i = 0; i < 300; i++) { physics.integrate(terrain, ship, physics.controlsFor('thrust'), 16); minVy = Math.min(minVy, ship.vy); }
  assert.ok(minVy > 0, `descent never reverses (min vy ${minVy.toFixed(2)})`);
  assert.ok(ship.vy < physics.SAFE_VY - 1, `brake settles at a safe touchdown rate (${ship.vy.toFixed(2)})`);
});

test('the reference flight plan lands every fixed scenario at 150ms and 300ms latency', async () => {
  for (const scenario of SCENARIOS) for (const latencyMs of [150, 300]) {
    const flight = await runFlight({ policy: reference, ship: scenario.ship, padCenter: scenario.padCenter, latencyMs });
    assert.ok(flight.landed, `${scenario.name} @${latencyMs}ms: off ${flight.padOffset.toFixed(0)} vy ${flight.vy.toFixed(2)} vx ${flight.vx.toFixed(2)} fuel ${flight.fuel.toFixed(0)}`);
    assert.ok(flight.counts.left_thrust + flight.counts.right_thrust > 0, 'the plan uses lateral maneuvers');
  }
});

test('the reference flight plan lands at least 95% of random missions (random pad and launch)', async () => {
  let landed = 0; const scenarios = randomScenarios(30, 7);
  for (const scenario of scenarios) for (const latencyMs of [150, 300]) landed += (await runFlight({ policy: reference, ship: scenario.ship, padCenter: scenario.padCenter, latencyMs })).landed;
  assert.ok(landed / (scenarios.length * 2) >= .95, `${landed}/${scenarios.length * 2} landed`);
});

test('random missions place the pad inside the world and the launch 150-600 m from it', () => {
  for (const m of randomScenarios(200, 11)) {
    assert.ok(m.padCenter >= physics.PAD_MIN && m.padCenter <= physics.PAD_MAX);
    const distance = Math.abs(m.ship.x - m.padCenter);
    assert.ok(distance >= 150 && distance <= 600, `launch ${distance.toFixed(0)} m from pad`);
    assert.ok(m.ship.x > 0 && m.ship.x < physics.WORLD_WIDTH);
  }
  const t = physics.telemetry(physics.makeTerrain(600), physics.createShip({ x: 900 }));
  assert.equal(Math.round(t.padOffset), 300, 'pad offset follows the moved pad');
});

test('assessment points lateral corrections toward the pad and brakes a fast low descent', () => {
  assert.equal(assess(telemetryFor({ x: 1000 })).recommended, 'right_thrust');
  assert.equal(assess(telemetryFor({ x: 1800 })).recommended, 'left_thrust');
  assert.equal(assess(telemetryFor({ x: 1360, vx: 12 })).lateralNeed, 'push_left', 'overshooting rightward must push left');
  assert.equal(assess(telemetryFor({ x: 1400, y: 950, vy: 12 })).recommended, 'thrust');
  assert.equal(assess(telemetryFor({ x: 1400, vx: 0 })).recommended, 'coast');
});

test('situation text never names the opposite direction or braking cues it does not mean', () => {
  // Laya is a text classifier: stray direction words or "slow down" measurably flip its answers.
  const samples = [];
  for (const scenario of [...SCENARIOS, ...randomScenarios(10, 3)]) samples.push(telemetryFor(scenario.ship, scenario.padCenter));
  for (let x = 400; x <= 2300; x += 150) for (const vx of [-12, -4, 0, 4, 12]) samples.push(telemetryFor({ x, vx }));
  for (const t of samples) {
    const a = assess(t), lateral = lateralSentence(a), vertical = verticalSentence(a);
    if (a.lateralNeed === 'hold') assert.doesNotMatch(lateral, /left|right/i, lateral);
    if (a.lateralNeed === 'push_right') assert.doesNotMatch(lateral, /LEFT/, lateral);
    if (a.lateralNeed === 'push_left') assert.doesNotMatch(lateral, /RIGHT/, lateral);
    assert.doesNotMatch(lateral, /brake|slow down/i, lateral);
    assert.equal(/must brake now/.test(vertical), a.mustBrake, vertical);
  }
});

test('binary variant asks three yes/no questions and maps scores to one control', () => {
  const [body] = buildRequests(telemetryFor({}), 'binary', 'english');
  assert.deepEqual(Object.keys(body.questions), ['brake', 'go_right', 'go_left']);
  assert.ok(Object.values(body.questions).every((q) => q.type === 'noul'));
  const answers = (brake, right, left) => ({ answers: { brake: { noul: brake }, go_right: { noul: right }, go_left: { noul: left } } });
  assert.equal(choiceFrom(answers(.8, .9, .1), 'binary'), 'thrust', 'braking has priority');
  assert.equal(choiceFrom(answers(.2, .8, .3), 'binary'), 'right_thrust');
  assert.equal(choiceFrom(answers(.2, .3, .7), 'binary'), 'left_thrust');
  assert.equal(choiceFrom(answers(.2, .3, .3), 'binary'), 'coast');
  assert.throws(() => choiceFrom({ answers: {} }, 'binary'), /safety envelope/);
});

test('split variant sends the brake question without any sideways wording', () => {
  const bodies = buildRequests(telemetryFor({ x: 1000 }), 'split');
  assert.equal(bodies.length, 2);
  assert.doesNotMatch(JSON.stringify(bodies[0].state), /left|right|sideways/i);
  assert.equal(choiceFrom(bodies.map(fakeLayaAnswers), 'split'), 'right_thrust');
});

test('relay endpoint returns a lateral maneuver when the pad is off to the side', async () => {
  const response = await fetch(`${relayUrl}/api/lander/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connection: { baseUrl: fakeUrl, token: 'top-secret-token' }, telemetry: telemetryFor({ x: 900 }) }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.action, 'right_thrust');
  assert.equal(JSON.stringify(body).includes('top-secret-token'), false);
});

test('closed loop through the live adapter code lands every fixed scenario with a faithful model', async () => {
  const connection = { baseUrl: fakeUrl, token: 'test-token' };
  for (const scenario of SCENARIOS) {
    const flight = await runFlight({ ship: scenario.ship, padCenter: scenario.padCenter, latencyMs: 200, policy: async (t) => (await decide(t, connection)).choice });
    assert.ok(flight.landed, `${scenario.name}: off ${flight.padOffset.toFixed(0)} vy ${flight.vy.toFixed(2)}`);
  }
});

test('JEV provider sends the Typesafe request shape with Bearer auth and parses its answers', async () => {
  const seen = [];
  const fakeJev = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { const body = JSON.parse(raw); seen.push({ auth: req.headers.authorization, apiKey: req.headers['x-api-key'], body }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fakeLayaAnswers(body))); });
  });
  await new Promise((resolve) => fakeJev.listen(0, resolve));
  try {
    const result = await decide(telemetryFor({ x: 900 }), { provider: 'jev', token: 'jev-secret', baseUrl: `http://127.0.0.1:${fakeJev.address().port}` });
    assert.equal(result.choice, 'right_thrust');
    assert.equal(result.provider, 'jev');
    assert.equal(seen[0].auth, 'Bearer jev-secret');
    assert.equal(seen[0].apiKey, undefined, 'Laya header is not sent to JEV');
    assert.equal(seen[0].body.model, 'jev-latest');
    assert.deepEqual(Object.keys(seen[0].body).sort(), ['model', 'questions', 'state']);
  } finally { await new Promise((r) => fakeJev.close(r)); }
});

test('yes/no answers are read from the common typed-decision shapes', () => {
  const { noulScore } = require('../src/lander-adapter');
  assert.equal(noulScore({ type: 'noul', noul: .83 }), .83);
  assert.equal(noulScore({ score: .2 }), .2);
  assert.equal(noulScore({ probability: .7 }), .7);
  assert.equal(noulScore({ answer: 'yes' }), 1);
  assert.equal(noulScore({ answer: false }), 0);
  assert.equal(noulScore(true), 1);
  assert.equal(noulScore({}), undefined);
  assert.equal(choiceFrom({ result: { answers: { brake: { score: .1 }, go_right: { score: .9 }, go_left: { score: .1 } } } }, 'binary'), 'right_thrust', 'answers nested under result are found');
});

test('JEV requests without an API key fail with a clear message', async () => {
  await assert.rejects(decide(telemetryFor({}), { provider: 'jev', token: '' }), /JEV API key is required/);
});

test('mission briefing is added to the state and every question; empty briefing leaves requests unchanged', () => {
  const { buildRequests: build } = require('../src/lander-adapter');
  const t = telemetryFor({ x: 900 });
  const plain = build(t, 'binary')[0];
  assert.deepEqual(build(t, 'binary', undefined, { briefing: '   ' })[0], plain);
  const briefed = build(t, 'binary', undefined, { briefing: 'Save\\nfuel.\u0007  Prefer coasting.' })[0];
  assert.equal(briefed.state.mission_briefing, 'Save\\nfuel. Prefer coasting.');
  assert.ok(Object.values(briefed.questions).every((q) => q.instructions.endsWith('Take the mission briefing into account.')));
  assert.equal(build(t, 'binary', undefined, { briefing: 'x'.repeat(900) })[0].state.mission_briefing.length, 500);
});

test('relay forwards the briefing and returns the exact request sent', async () => {
  const response = await fetch(`${relayUrl}/api/lander/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connection: { baseUrl: fakeUrl, token: 'top-secret-token' }, briefing: 'Conserve fuel.', telemetry: telemetryFor({ x: 900 }) }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.request.state.mission_briefing, 'Conserve fuel.');
  assert.equal(JSON.stringify(body).includes('top-secret-token'), false);
  const spec = require('../public/lander-spec').spec();
  assert.equal(spec.variant, 'binary');
  assert.deepEqual(Object.keys(spec.example.request.questions), ['brake', 'go_right', 'go_left']);
  assert.equal(JSON.stringify(spec).includes('secret'), false);
});

test('touchdown outcomes: soft on the pad lands, soft off the pad is intact but not a success, hard or steep crashes', () => {
  const pad = physics.PAD_CENTER, t = physics.makeTerrain(pad), coast = physics.controlsFor('coast');
  const touch = (x, vy, vx = 0) => {
    const ship = physics.createShip({ x, y: physics.groundAt(t, x).y - physics.SHIP_FOOT - .5, vx, vy, a: 0 });
    for (let i = 0; i < 20; i++) { const r = physics.integrate(t, ship, coast, 16); if (r.touchdown) return { ...r.touchdown, ship }; }
    throw new Error('no touchdown');
  };
  const onPad = touch(pad + 10, 2);
  assert.equal(onPad.outcome, 'landed'); assert.ok(onPad.safe && onPad.soft);
  // Find flat and steep ground away from the pad.
  const xs = []; for (let x = 100; x < 2300; x += 4) if (Math.abs(x - pad) > 200) xs.push(x);
  const flat = xs.find((x) => Math.abs(physics.groundAt(t, x).slope) < .05), steep = xs.find((x) => Math.abs(physics.groundAt(t, x).slope) > .45);
  const offPad = touch(flat, 2);
  assert.equal(offPad.outcome, 'off_pad'); assert.equal(offPad.safe, false); assert.equal(offPad.soft, true);
  assert.equal(offPad.ship.vy, 0, 'an intact craft comes to rest');
  assert.equal(touch(flat, 8).outcome, 'crashed', 'too fast off the pad crashes');
  assert.equal(touch(pad, 8).outcome, 'crashed', 'too fast on the pad crashes');
  assert.equal(touch(steep, 2).outcome, 'crashed', 'a gentle touchdown on a steep slope tips over');
});

test('facts-only prompt states measurements without conclusions', () => {
  const samples = [...SCENARIOS, ...randomScenarios(10, 5)].map((s) => telemetryFor(s.ship, s.padCenter));
  samples.push(telemetryFor({ x: 1400, y: 950, vy: 14 }), telemetryFor({ x: 1370, vx: 10 }));
  for (const t of samples) {
    const body = buildRequests(t, 'facts')[0];
    assert.deepEqual(Object.keys(body.state), ['vertical_facts', 'sideways_facts']);
    const text = JSON.stringify(body.state);
    assert.doesNotMatch(text, /must|required|danger|too fast|overshoot|brake now|needs? to|should/i, text);
    assert.match(body.state.vertical_facts, /Altitude above the ground: \d+ m/);
    assert.deepEqual(Object.keys(body.questions), ['brake', 'go_right', 'go_left']);
  }
});
