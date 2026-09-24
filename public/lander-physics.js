'use strict';

// Shared flight model. Loaded by the browser game and by the Node simulator/test suite
// so both fly exactly the same physics.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LanderPhysics = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const WORLD_WIDTH = 2400, WORLD_HEIGHT = 1450, PAD_CENTER = 1400, PAD_HALF_WIDTH = 72, PAD_MIN = 320, PAD_MAX = 2080;
  const LUNAR_GRAVITY = 1.62, ENGINE_ACCELERATION = 4.8, DIRECTIONAL_ACCELERATION = 2.8, YAW_RATE = .25, SIMULATION_TIME_SCALE = 2.5;
  const MAX_TILT = .62, SAFE_VY = 4.5, SAFE_VX = 3.0, SAFE_TILT = .35, SHIP_FOOT = 18, MAX_LANDING_SLOPE = .3;
  // Autopilot maneuvers run through an attitude-hold loop (like a real lander's stability
  // augmentation): each command sets a target tilt and throttle, and the craft slews to it.
  const MANEUVER_TILT = .5, SLEW_RATE = 1.1, BRAKE_FLOOR_VY = 1.5, DRIFT_TILT = .2;
  const CONTROLS = ['left_thrust', 'right_thrust', 'thrust', 'coast'];

  function noise(x) { const n = Math.sin(x * 12.9898 + 78.233) * 43758.5453; return n - Math.floor(n); }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function valueNoise(x) { const i = Math.floor(x), f = smooth(x - i); return noise(i) * (1 - f) + noise(i + 1) * f; }
  function terrainY(x) { const t = Math.max(0, Math.min(WORLD_WIDTH, x)) / WORLD_WIDTH; return 1030 + (valueNoise(t * 13) - .5) * 90 + (valueNoise(t * 29) - .5) * 30 + Math.sin(t * 26) * 14; }
  // The terrain array carries its landing pad: terrain.padCenter / terrain.padY.
  function makeTerrain(padCenter = PAD_CENTER) {
    const terrain = [], step = 16, padY = terrainY(padCenter);
    for (let x = -40; x <= WORLD_WIDTH + 40; x += step) terrain.push({ x, y: x >= padCenter - PAD_HALF_WIDTH - 18 && x <= padCenter + PAD_HALF_WIDTH + 18 ? padY : terrainY(x) });
    terrain.padCenter = padCenter; terrain.padY = padY;
    return terrain;
  }
  // A random pad plus a launch point 150-600 m to either side of it. `rand` returns [0, 1).
  function randomMission(rand = Math.random) {
    const padCenter = Math.round(PAD_MIN + rand() * (PAD_MAX - PAD_MIN));
    const side = rand() < .5 ? -1 : 1, distance = 150 + rand() * 450;
    let x = padCenter + side * distance;
    if (x < 80 || x > WORLD_WIDTH - 80) x = padCenter - side * distance;
    const round = (v) => Math.round(v * 100) / 100;
    return { padCenter, ship: { x: round(x), y: round(170 + rand() * 160), vx: round((rand() - .5) * 3), vy: round(rand() * 1.5), a: round((rand() - .5) * .6) } };
  }
  function groundAt(terrain, x) {
    for (let i = 1; i < terrain.length; i++) if (terrain[i - 1].x <= x && terrain[i].x >= x) { const a = terrain[i - 1], b = terrain[i], t = (x - a.x) / (b.x - a.x); return { y: a.y + (b.y - a.y) * t, slope: Math.atan2(b.y - a.y, b.x - a.x) }; }
    return { y: WORLD_HEIGHT, slope: 0 };
  }
  function createShip(overrides = {}) { return { x: 1160, y: 250, vx: .8, vy: .1, a: .02, fuel: 100, ...overrides }; }
  function landingRay(ship, padCenter = PAD_CENTER) {
    const target = { x: padCenter, y: terrainY(padCenter) - SHIP_FOOT };
    const deltaX = target.x - ship.x, deltaY = target.y - ship.y, range = Math.hypot(deltaX, deltaY) || 1;
    return { targetX: target.x, targetY: target.y, range, deltaX, deltaY, bearing: Math.atan2(deltaX, deltaY), closingSpeed: (deltaX * ship.vx + deltaY * ship.vy) / range };
  }
  function padOf(terrain) { return terrain.padCenter ?? PAD_CENTER; }
  function telemetry(terrain, ship) {
    const ground = groundAt(terrain, ship.x), altitude = Math.max(0, ground.y - ship.y - SHIP_FOOT);
    return { altitude, verticalVelocity: ship.vy, horizontalVelocity: ship.vx, orientation: ship.a, padOffset: ship.x - padOf(terrain), fuel: ship.fuel, terrainSlope: ground.slope * 180 / Math.PI, phase: altitude < 95 ? 'landing' : altitude < 270 ? 'descent' : 'approach', landingRay: landingRay(ship, padOf(terrain)) };
  }
  // Autopilot command -> attitude-hold maneuver.
  function controlsFor(command) {
    const targetTilt = command === 'left_thrust' ? -MANEUVER_TILT : command === 'right_thrust' ? MANEUVER_TILT : 0;
    return { targetTilt, thrust: command !== 'coast', directional: command === 'left_thrust' || command === 'right_thrust', limitDescent: command === 'thrust', nullDrift: command === 'thrust' };
  }
  // Manual keyboard input -> raw yaw and engine.
  function manualControls(keys) { return { yawLeft: Boolean(keys.yawLeft), yawRight: Boolean(keys.yawRight), thrust: Boolean(keys.thrust), directional: false }; }
  // Advances the ship by dt wall-clock milliseconds. Returns null in flight, or the touchdown result.
  function integrate(terrain, ship, control, dt) {
    const seconds = dt / 1000 * SIMULATION_TIME_SCALE;
    if (typeof control.targetTilt === 'number') {
      // Brake burns lean slightly against sideways drift (like Apollo's P66 mode) so the
      // craft does not touch down sliding.
      const target = control.nullDrift ? Math.max(-DRIFT_TILT, Math.min(DRIFT_TILT, -ship.vx * .08)) : control.targetTilt;
      const error = target - ship.a, slew = SLEW_RATE * seconds;
      ship.a += Math.max(-slew, Math.min(slew, error));
    } else {
      if (control.yawLeft) ship.a -= YAW_RATE * seconds;
      if (control.yawRight) ship.a += YAW_RATE * seconds;
      ship.a *= .998;
    }
    ship.a = Math.max(-MAX_TILT, Math.min(MAX_TILT, ship.a));
    let burning = false;
    if (control.thrust && ship.fuel > 0) {
      let acceleration = control.directional ? DIRECTIONAL_ACCELERATION : ENGINE_ACCELERATION;
      // Brake burns throttle down as the craft approaches the safe descent rate so a single
      // decision cannot overshoot into a hover or climb.
      if (control.limitDescent) acceleration *= Math.max(0, Math.min(1, (ship.vy - BRAKE_FLOOR_VY) / 3));
      ship.vx += Math.sin(ship.a) * acceleration * seconds; ship.vy -= Math.cos(ship.a) * acceleration * seconds;
      ship.fuel -= (control.directional ? 1.35 : 2.5) * seconds * acceleration / (control.directional ? DIRECTIONAL_ACCELERATION : ENGINE_ACCELERATION); burning = true;
    }
    ship.vy += LUNAR_GRAVITY * seconds; ship.x += ship.vx * seconds; ship.y += ship.vy * seconds;
    ship.x = Math.max(14, Math.min(WORLD_WIDTH - 14, ship.x));
    const g = groundAt(terrain, ship.x);
    if (ship.y + SHIP_FOOT < g.y) return { burning, touchdown: null };
    const within = Math.abs(ship.x - padOf(terrain)) < PAD_HALF_WIDTH;
    // soft: the gear survives (gentle, level, on ground that is not too steep).
    // safe: a soft touchdown on the pad; a soft touchdown elsewhere is an off-pad landing.
    const soft = Math.abs(ship.vy) < SAFE_VY && Math.abs(ship.vx) < SAFE_VX && Math.abs(ship.a) < SAFE_TILT && (within || Math.abs(g.slope) < MAX_LANDING_SLOPE);
    const safe = soft && within;
    const outcome = safe ? 'landed' : soft ? 'off_pad' : 'crashed';
    const touchdown = { safe, soft, within, outcome, x: ship.x, padOffset: ship.x - padOf(terrain), vx: ship.vx, vy: ship.vy, a: ship.a, slope: g.slope, fuel: ship.fuel, groundY: g.y };
    if (soft) { ship.y = g.y - SHIP_FOOT; ship.vx = 0; ship.vy = 0; ship.a = 0; }
    return { burning, touchdown };
  }

  return { WORLD_WIDTH, WORLD_HEIGHT, PAD_CENTER, PAD_HALF_WIDTH, PAD_MIN, PAD_MAX, LUNAR_GRAVITY, ENGINE_ACCELERATION, DIRECTIONAL_ACCELERATION, YAW_RATE, SIMULATION_TIME_SCALE, MAX_TILT, MANEUVER_TILT, SLEW_RATE, BRAKE_FLOOR_VY, DRIFT_TILT, SAFE_VY, SAFE_VX, SAFE_TILT, SHIP_FOOT, MAX_LANDING_SLOPE, CONTROLS, noise, terrainY, makeTerrain, randomMission, padOf, groundAt, createShip, landingRay, telemetry, controlsFor, manualControls, integrate };
}));
