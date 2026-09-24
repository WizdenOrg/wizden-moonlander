'use strict';

// Live acceptance suite, run per configured provider (others are skipped):
//   LAYA_URL=https://... LAYA_TOKEN=... JEV_KEY=... node --test test/lander-live.test.js
// For the full report (confusion matrix, per-scenario flights) use scripts/lander-eval.js --provider laya|jev.
const test = require('node:test');
const assert = require('node:assert/strict');
const physics = require('../public/lander-physics');
const { runFlight, SCENARIOS } = require('../src/lander-sim');
const { assess } = require('../src/lander-guidance');
const { decide, DEFAULT_VARIANT } = require('../src/lander-adapter');

const variant = process.env.LAYA_VARIANT || DEFAULT_VARIANT;
const providers = {
  laya: { connection: { provider: 'laya', baseUrl: process.env.LAYA_URL, token: process.env.LAYA_TOKEN, model: process.env.LAYA_MODEL || 'english', variant }, ready: Boolean(process.env.LAYA_URL && process.env.LAYA_TOKEN), hint: 'set LAYA_URL and LAYA_TOKEN' },
  jev: { connection: { provider: 'jev', token: process.env.JEV_KEY, variant }, ready: Boolean(process.env.JEV_KEY), hint: 'set JEV_KEY' }
};
const terrain = physics.makeTerrain();
const cases = [
  { name: 'pad far right, hovering', ship: { x: 1000, vx: 0 }, expected: 'right_thrust' },
  { name: 'pad far left, hovering', ship: { x: 1850, vx: 0 }, expected: 'left_thrust' },
  { name: 'pad right, drifting away left', ship: { x: 1150, vx: -3 }, expected: 'right_thrust' },
  { name: 'pad left, drifting away right', ship: { x: 1650, vx: 3 }, expected: 'left_thrust' },
  { name: 'overshooting to the right', ship: { x: 1370, vx: 10 }, expected: 'left_thrust' },
  { name: 'overshooting to the left', ship: { x: 1430, vx: -10 }, expected: 'right_thrust' },
  { name: 'on plan toward pad', ship: { x: 1200, vx: 12 }, expected: 'coast' },
  { name: 'over pad, still', ship: { x: 1400, vx: 0 }, expected: 'coast' },
  { name: 'over pad, falling fast low', ship: { x: 1400, y: 950, vy: 14 }, expected: 'thrust' },
  { name: 'over pad, overspeed high', ship: { x: 1400, y: 300, vy: 25 }, expected: 'thrust' }
];

for (const [name, { connection, ready, hint }] of Object.entries(providers)) {
  const skip = !ready && hint;

  test(`${name} picks the planned control on canonical flight states`, { skip, timeout: 120000 }, async () => {
    const misses = [];
    for (const c of cases) {
      const t = physics.telemetry(terrain, physics.createShip(c.ship));
      assert.equal(assess(t).recommended, c.expected, `fixture ${c.name} matches the flight plan`);
      const { choice } = await decide(t, connection);
      if (choice !== c.expected) misses.push(`${c.name}: expected ${c.expected}, got ${choice}`);
    }
    assert.ok(misses.length <= 1, misses.join('\n'));
  });

  test(`${name} lands the fixed scenarios and uses lateral maneuvers`, { skip, timeout: 900000 }, async () => {
    const results = await Promise.all(SCENARIOS.map(async (scenario) => {
      const flight = await runFlight({ ship: scenario.ship, padCenter: scenario.padCenter, latencyMs: 200, policy: async (t) => (await decide(t, connection)).choice });
      return { name: scenario.name, landed: flight.landed, lateral: flight.counts.left_thrust + flight.counts.right_thrust, off: Math.round(flight.padOffset), vy: +flight.vy.toFixed(2) };
    }));
    const landed = results.filter((r) => r.landed).length;
    assert.ok(landed >= SCENARIOS.length - 1, JSON.stringify(results, null, 1));
    assert.ok(results.every((r) => r.lateral > 0), 'every flight used left_thrust or right_thrust');
  });
}
