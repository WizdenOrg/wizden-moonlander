'use strict';

// Headless closed-loop simulator. Mirrors the browser loop in public/app.js:
// a telemetry snapshot is taken, the policy answers after `latencyMs`, the previous
// command stays active until then, and the next request fires `decisionIntervalMs` later.
const physics = require('../public/lander-physics');

async function runFlight({ policy, ship: shipOverrides = {}, padCenter = physics.PAD_CENTER, decisionIntervalMs = 480, latencyMs = 150, frameMs = 16, maxWallMs = 120000 } = {}) {
  const terrain = physics.makeTerrain(padCenter);
  const ship = physics.createShip(shipOverrides);
  const start = { ...ship };
  const log = [];
  const counts = Object.fromEntries(physics.CONTROLS.map((c) => [c, 0]));
  let command = 'coast', clock = 0, nextRequest = 0, pending = null, previous = null;
  while (clock < maxWallMs) {
    if (!pending && clock >= nextRequest) {
      const snapshot = physics.telemetry(terrain, ship);
      const decision = await policy(snapshot, { previous, clock });
      const choice = typeof decision === 'string' ? decision : decision.choice;
      if (!physics.CONTROLS.includes(choice)) throw new Error(`Policy returned invalid control ${choice}`);
      pending = { choice, applyAt: clock + latencyMs, snapshot, meta: typeof decision === 'object' ? decision : null };
    }
    if (pending && clock >= pending.applyAt) {
      command = pending.choice; counts[command]++; previous = command;
      log.push({ t: clock, command, alt: pending.snapshot.altitude, off: pending.snapshot.padOffset, vx: pending.snapshot.horizontalVelocity, vy: pending.snapshot.verticalVelocity, a: pending.snapshot.orientation, fuel: pending.snapshot.fuel, meta: pending.meta?.meta });
      nextRequest = clock + decisionIntervalMs; pending = null;
    }
    const { touchdown } = physics.integrate(terrain, ship, physics.controlsFor(command), frameMs);
    clock += frameMs;
    if (touchdown) return { ...touchdown, landed: touchdown.safe, timedOut: false, wallMs: clock, decisions: log.length, counts, log, start };
  }
  return { safe: false, landed: false, timedOut: true, padOffset: ship.x - padCenter, vx: ship.vx, vy: ship.vy, a: ship.a, fuel: ship.fuel, wallMs: clock, decisions: log.length, counts, log, start };
}

// Launch conditions used by the test suite: the default game start plus lateral offsets on both sides.
const SCENARIOS = [
  { name: 'default start (pad 240m right)', ship: {} },
  { name: 'pad 400m right', ship: { x: 1000 } },
  { name: 'pad 300m left', ship: { x: 1700, vx: -.5 } },
  { name: 'pad 500m left, drifting away', ship: { x: 1900, vx: .6 } },
  { name: 'nearly overhead, tilted', ship: { x: 1440, a: -.4 } },
  { name: 'pad 600m right, fast drift away', ship: { x: 800, vx: -1.2 } }
];

// Seeded random missions (random pad + launch) for robustness checks (mulberry32).
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function randomScenarios(count, seed = 1) {
  const rand = seededRandom(seed);
  return Array.from({ length: count }, (_, i) => {
    const mission = physics.randomMission(rand);
    return { name: `random #${i + 1} (seed ${seed}, pad ${mission.padCenter})`, ...mission };
  });
}

module.exports = { runFlight, SCENARIOS, randomScenarios, physics };
