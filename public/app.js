'use strict';

// Moon lander front end.
// - One or two pilots (Laya, JEV, or both side by side) fly the same mission: same pad, same launch.
// - Each pilot owns a Flight: its ship, decision stream, canvas pane and playback state.
// - Simulation and rendering are decoupled. The simulation records timestamped frames as fast as
//   decisions arrive; the screen plays them back smoothly (interpolated, adaptive rate), so the
//   bursty lockstep used at higher speeds never shows as stutter.

const $ = (id) => document.getElementById(id);
const P = window.LanderPhysics; // shared with the Node simulator and test suite
const { WORLD_WIDTH, PAD_CENTER, PAD_HALF_WIDTH, noise, terrainY } = P;

const CONNECTION_STORAGE_KEY = 'laya-moon-lander.connection.v1';
const CAMPAIGN_STORAGE_KEY = 'laya-moon-lander.campaign.v1';
const SETTINGS_STORAGE_KEY = 'laya-moon-lander.settings.v1';
const NEXT_MISSION_DELAY_MS = 2600, PATH_SAMPLE_MS = 120, MAX_MISSIONS = 100, SIM_STEP_MS = 16;
// Above 1x each flight runs in lockstep with its model: it waits at each decision point for the
// answer, then fast-forwards. The model keeps the same decision cadence (in game time) as at 1x,
// matching the headless simulator: the command lands LOCK_LATENCY_MS after the snapshot and the
// next snapshot is DECISION_INTERVAL_MS after that.
const DECISION_INTERVAL_MS = 480, LOCK_LATENCY_MS = 150, SPEEDS = { 1: 1, 2: 2, 4: 4, 8: 8, max: 64 };
// Playback runs behind the simulation head by a buffer that absorbs the decision bursts
// (at least 1.6 decision cycles; more when the provider is slow), at a steady rate.
const DECISION_CYCLE_MS = DECISION_INTERVAL_MS + LOCK_LATENCY_MS, MIN_PLAYBACK_BUFFER_MS = DECISION_CYCLE_MS * 1.6, RATE_WINDOW_MS = 3000;
const PILOTS = { laya: { label: 'LAYA', color: '#fa935b' }, jev: { label: 'JEV', color: '#60a5fa' } };
const PILOT_MODES = { laya: ['laya'], jev: ['jev'], duel: ['laya', 'jev'] };
// Touchdown effects run on wall-clock time; keep at least this long between missions so they play out.
const EFFECTS_MS = 1800, REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CONFETTI_COLORS = ['#fa935b', '#4ade80', '#ffffff', '#60a5fa', '#a78bfa', '#fdba8c'];

let terrain = P.makeTerrain(), stars = [], flights = [], keys = {};
let running = false, paused = false, autopilot = true, missionSerial = 0, countdownUntil = 0, advanceTimer = 0, boardClock = 0, last = 0, calls = 0;
let settings = { speed: '1', missions: 10, pilots: 'laya', briefing: '', prompt: 'binary' };
const PROMPT_LABELS = { binary: 'GUIDED', facts: 'FACTS ONLY' };
// Example briefings for facts-only mode, with results measured on JEV (facts-only prompt).
const BRIEFING_EXAMPLES = [
  { label: 'Flight rules', result: '14/20 landed · soft touchdowns', recommended: true, text: 'Default: no burn. Brake if altitude is below 50 m, or below this altitude for the falling speed: 10 m/s: 90 m. 15 m/s: 150 m. 20 m/s: 220 m. Over 20 m/s: always. Sideways target speed toward the pad: pad over 200 m away: 12 m/s. 100 m: 10. 50 m: 6. 20 m: 2. Below the craft: 0. Accelerate toward the pad only if slower than target by more than 2 m/s, or moving away. Accelerate away from the pad only if faster than target by more than 2 m/s. Otherwise no sideways burn.' },
  { label: 'Braking table', result: '0/6 landed · 48% decisions', text: 'Braking rule: falling 5 m/s, brake below 25 m altitude. Falling 10 m/s, brake below 60 m. Falling 15 m/s, brake below 110 m. Falling 20 m/s, brake below 170 m. Falling faster than 22 m/s, always brake. Above those altitudes do not brake. Sideways: accelerate toward the pad until moving about 10 m/s toward it; when less than 100 m from the pad and moving faster than 5 m/s toward it, accelerate away from the pad.' },
  { label: 'Plain intent', result: '26% decisions · never brakes', text: 'Do not brake while high up. Let the craft fall and only brake near the ground. Use sideways burns to get over the pad early.' }
];
const promptMode = () => campaign.current?.prompt || settings.prompt;
// Exact requests sent, for the tech specification panel.
let lastRequests = {}, firstRequests = {};
// Campaign: a batch of back-to-back missions, each with a random pad and launch point.
let campaign = { current: null, history: [] }, mission = null, missionEnding = false;

const speedFactor = () => SPEEDS[settings.speed] || 1;
const campaignSize = () => campaign.current?.total || settings.missions;
const activePilots = () => PILOT_MODES[settings.pilots] || PILOT_MODES.laya;
const lockstep = () => autopilot && speedFactor() > 1;
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- connection settings
function connectionFor(pilot) {
  const variant = (mission || running) ? promptMode() : settings.prompt;
  if (pilot === 'jev') return { provider: 'jev', token: $('jev-key').value.trim(), variant };
  return { provider: 'laya', baseUrl: $('base-url').value.trim(), token: $('api-token').value, variant };
}
function restoreConnection() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONNECTION_STORAGE_KEY) || '{}');
    if (typeof saved.baseUrl === 'string') $('base-url').value = saved.baseUrl;
    if (typeof saved.token === 'string') $('api-token').value = saved.token;
    if (typeof saved.jevKey === 'string') $('jev-key').value = saved.jevKey;
  } catch { /* ignore corrupt storage */ }
  renderProviderState();
}
function persistConnection() {
  try { localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ baseUrl: $('base-url').value.trim(), token: $('api-token').value, jevKey: $('jev-key').value.trim() })); } catch { /* storage unavailable */ }
  renderProviderState();
}
function clearConnection() {
  try { localStorage.removeItem(CONNECTION_STORAGE_KEY); } catch { /* storage unavailable */ }
  $('api-token').value = ''; $('jev-key').value = '';
  renderProviderState();
}
function renderProviderState() {
  const laya = $('api-token').value ? 'LAYA ✓' : 'LAYA —', jev = $('jev-key').value ? 'JEV ✓' : 'JEV —';
  $('provider-state').textContent = `${laya} · ${jev}`;
}
function missingKeys() {
  return activePilots().filter((pilot) => !connectionFor(pilot).token).map((pilot) => PILOTS[pilot].label);
}

// ---------------------------------------------------------------- panes (one canvas per pilot)
function buildPanes() {
  const host = $('panes');
  host.replaceChildren();
  host.classList.toggle('is-duel', flights.length > 1);
  for (const flight of flights) {
    const pane = document.createElement('div');
    pane.className = 'pane';
    pane.dataset.pilot = flight.pilot;
    pane.innerHTML = `
      <canvas tabindex="0" aria-label="${PILOTS[flight.pilot].label} flight view"></canvas>
      <div class="canvas-vignette" aria-hidden="true"></div>
      <div class="hud top-hud" aria-label="${PILOTS[flight.pilot].label} telemetry">
        <span class="pilot-chip" style="--pilot:${PILOTS[flight.pilot].color}">${PILOTS[flight.pilot].label}</span>
        <div><small>ALTITUDE</small><b data-f="alt">0000 M</b></div>
        <div><small>VELOCITY</small><b data-f="vel">V +0.00</b></div>
        <div><small>FUEL</small><b data-f="fuel">100%</b></div>
        <div><small>PAD OFFSET</small><b data-f="off">+000 M</b></div>
      </div>
      <div class="command-card"><small>MODEL COMMAND</small><b data-f="cmd">COAST</b><span data-f="timer">awaiting launch</span></div>
      <div class="pane-result" data-f="result" hidden></div>`;
    host.append(pane);
    const canvas = pane.querySelector('canvas');
    flight.view = { pane, canvas, ctx: canvas.getContext('2d'), width: 0, height: 0, dpr: 1, scale: 1, fields: Object.fromEntries([...pane.querySelectorAll('[data-f]')].map((el) => [el.dataset.f, el])) };
    new ResizeObserver(() => resizeView(flight.view)).observe(canvas);
    resizeView(flight.view);
  }
}
function resizeView(view) {
  const box = view.canvas.getBoundingClientRect();
  view.dpr = Math.min(devicePixelRatio || 1, 2); view.width = box.width; view.height = box.height;
  view.canvas.width = view.width * view.dpr; view.canvas.height = view.height * view.dpr;
  view.ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  view.scale = Math.max(.42, Math.min(1.05, view.width / 1050));
}

// ---------------------------------------------------------------- flights
function makeStars() { stars = Array.from({ length: 240 }, (_, i) => ({ x: noise(i * 3) * WORLD_WIDTH, y: noise(i * 7) * 900, r: .5 + noise(i * 11) * 1.4, z: noise(i * 17) })); }
function frameOf(ship, command, burning, t) { return { t, x: ship.x, y: ship.y, a: ship.a, vx: ship.vx, vy: ship.vy, fuel: ship.fuel, command, burning }; }
function createFlight(pilot, launch, record) {
  const ship = P.createShip(launch);
  return {
    pilot, ship, record, command: 'coast', simEnded: false, displayEnded: false, touchdown: null,
    // simulation clocks (game milliseconds, 1x wall-clock equivalent)
    gameClock: 0, pathClock: 0, missionClock: 0,
    // decision scheduling
    deciding: false, nextDecision: 0, lock: { awaiting: false, nextDecision: 0, pending: null },
    // playback
    frames: [frameOf(ship, 'coast', false, 0)], displayT: 0, playRate: 0, playing: false, production: [], lastAnswerMs: 0, display: frameOf(ship, 'coast', false, 0),
    trail: [], dust: [], fx: { debris: [], fire: [], rings: [], confetti: [], flash: 0, padGlow: 0, exploded: false }, camera: { x: ship.x, y: ship.y + 250 }, shake: 0, view: null
  };
}
function flightControls(flight) {
  if (autopilot || flights[0] !== flight) return P.controlsFor(flight.command);
  return P.manualControls({ yawLeft: keys.KeyA || keys.ArrowLeft, yawRight: keys.KeyD || keys.ArrowRight, thrust: (keys.KeyW || keys.Space) && !keys.KeyS });
}

// One live decision for a flight's current snapshot. Returns the relay payload, or null when the
// mission changed meanwhile or the provider failed (which pauses the campaign).
async function fetchDecision(flight) {
  const serial = missionSerial, snapshot = P.telemetry(terrain, flight.ship);
  flight.view.fields.timer.textContent = 'requesting live control...';
  try {
    const response = await fetch('/api/lander/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ telemetry: snapshot, connection: connectionFor(flight.pilot), briefing: campaign.current?.briefing || '' }) });
    const data = await response.json();
    if (serial !== missionSerial || flight.simEnded) return null;
    if (!response.ok) throw new Error(data.error || 'Provider request failed.');
    flight.record.counts[data.action] = (flight.record.counts[data.action] || 0) + 1;
    flight.lastAnswerMs = data.latencyMs || 0;
    recordRequest(flight, data);
    flight.view.fields.timer.textContent = lockstep() ? `×${settings.speed === 'max' ? 'MAX' : settings.speed} set · ${flight.playing ? `${flight.playRate.toFixed(1)}× actual` : 'buffering'} · ${data.latencyMs}ms answers` : `${data.latencyMs}ms · next in 0.48s`;
    showDecision(flight.pilot, data);
    return data;
  } catch (error) {
    if (serial !== missionSerial) return null;
    paused = true; $('pause').textContent = 'RESUME';
    setStatus(`${PILOTS[flight.pilot].label} PROVIDER ERROR`, `${error.message} The campaign is paused until the connection is fixed.`);
    return null;
  }
}
// 1x: real time. The flight keeps moving while a request is in the air.
async function requestDecision(flight) {
  flight.deciding = true; const serial = missionSerial;
  const data = await fetchDecision(flight);
  if (serial !== missionSerial) return;
  flight.deciding = false;
  if (data) { flight.command = data.action; flight.nextDecision = performance.now() + DECISION_INTERVAL_MS; }
}
// >1x: lockstep. The flight's simulation is frozen until the answer arrives.
async function lockDecision(flight) {
  flight.lock.awaiting = true; const serial = missionSerial;
  const data = await fetchDecision(flight);
  if (serial !== missionSerial || !data) return;
  flight.lock.pending = { choice: data.action, applyAt: flight.gameClock + LOCK_LATENCY_MS };
  flight.lock.nextDecision = flight.gameClock + LOCK_LATENCY_MS + DECISION_INTERVAL_MS;
  flight.lock.awaiting = false;
}

// Advances one flight's simulation by h game milliseconds and records the frame.
function advance(flight, h) {
  const { burning, touchdown } = P.integrate(terrain, flight.ship, flightControls(flight), h);
  flight.gameClock += h; flight.pathClock += h;
  flight.missionClock += h / 1000 * P.SIMULATION_TIME_SCALE;
  flight.frames.push(frameOf(flight.ship, flight.command, burning, flight.gameClock));
  if (flight.pathClock >= PATH_SAMPLE_MS || touchdown) { flight.pathClock = 0; flight.record.path.push([Math.round(flight.ship.x), Math.round(flight.ship.y)]); }
  flight.record.fuel = flight.ship.fuel; flight.record.simSeconds = flight.missionClock;
  if (touchdown) finishFlight(flight, touchdown);
}
function simulate(flight, dt) {
  if (flight.simEnded) return;
  if (!lockstep()) {
    if (autopilot && !flight.deciding && performance.now() >= flight.nextDecision) requestDecision(flight);
    advance(flight, dt);
    return;
  }
  let budget = dt * speedFactor();
  while (budget > 0 && !flight.simEnded) {
    const lock = flight.lock;
    if (lock.awaiting) return;
    if (flight.gameClock >= lock.nextDecision) { lockDecision(flight); return; }
    if (lock.pending && flight.gameClock >= lock.pending.applyAt) { flight.command = lock.pending.choice; lock.pending = null; }
    const boundary = Math.min(lock.nextDecision, lock.pending ? lock.pending.applyAt : Infinity) - flight.gameClock;
    const h = Math.max(1, Math.min(SIM_STEP_MS, budget, boundary));
    advance(flight, h); budget -= h;
  }
}
// Moves the flight's display clock toward the simulation head at a steady rate.
function playback(flight, dt) {
  const head = flight.frames[flight.frames.length - 1].t;
  if (!lockstep()) { flight.displayT = head; flight.playing = false; }
  else {
    // Sustained throughput: game ms produced per wall ms over the last few seconds.
    const now = performance.now(), log = flight.production;
    log.push([now, head]);
    while (log.length > 2 && now - log[1][0] > RATE_WINDOW_MS) log.shift();
    const span = now - log[0][0], throughput = span > 250 ? (head - log[0][1]) / span : 0;
    // Deeper buffer when answers are slow, so bursts never drain it.
    const buffer = Math.max(MIN_PLAYBACK_BUFFER_MS, DECISION_CYCLE_MS + flight.lastAnswerMs * speedFactor() * .5);
    const lag = head - flight.displayT;
    if (!flight.playing && (lag >= buffer || flight.simEnded)) { flight.playing = true; flight.playRate = Math.max(throughput, .3); }
    if (flight.playing) {
      // Gentle lag correction around the sustained rate, then low-pass the rate itself.
      const correction = flight.simEnded ? .25 : Math.max(-.35, Math.min(.35, (lag - buffer) / buffer * .35));
      const target = Math.max(.15, (throughput || flight.playRate) * (1 + correction));
      flight.playRate += (target - flight.playRate) * Math.min(1, dt / 700);
      flight.displayT = Math.min(head, flight.displayT + flight.playRate * dt);
    }
  }
  // Interpolate between recorded frames and drop the ones already shown.
  const frames = flight.frames;
  while (frames.length > 2 && frames[1].t <= flight.displayT) frames.shift();
  const a = frames[0], b = frames[1] || a, span = b.t - a.t, k = span > 0 ? Math.min(1, Math.max(0, (flight.displayT - a.t) / span)) : 1;
  const lerp = (u, v) => u + (v - u) * k;
  flight.display = { t: flight.displayT, x: lerp(a.x, b.x), y: lerp(a.y, b.y), a: lerp(a.a, b.a), vx: lerp(a.vx, b.vx), vy: lerp(a.vy, b.vy), fuel: lerp(a.fuel, b.fuel), command: b.command, burning: b.burning };
  if (flight.display.burning && !flight.displayEnded) flight.trail.push({ x: flight.display.x, y: flight.display.y + 17, life: 1 });
  flight.trail.forEach((p) => { p.life -= .026 * dt; p.y += .05 * dt; }); flight.trail = flight.trail.filter((p) => p.life > 0);
  flight.dust.forEach((p) => { p.life -= .018 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }); flight.dust = flight.dust.filter((p) => p.life > 0);
  updateEffects(flight, dt);
  const easing = Math.min(1, dt * .012), view = flight.view;
  flight.camera.x += (flight.display.x - flight.camera.x) * easing;
  flight.camera.y += (flight.display.y + (view.height / view.scale) * .18 - flight.camera.y) * easing;
  if (flight.simEnded && !flight.displayEnded && flight.displayT >= head) showTouchdown(flight);
}

// ---------------------------------------------------------------- touchdown effects
const rand = (a, b) => a + Math.random() * (b - a);
// Crash: flash, shockwave, fireball fading to smoke, and hull fragments that tumble and bounce.
function explode(flight) {
  const fx = flight.fx, t = flight.touchdown, x = t.x, y = t.groundY - 12, n = REDUCED_MOTION ? .35 : 1;
  fx.exploded = true; fx.flash = REDUCED_MOTION ? .4 : 1;
  fx.rings.push({ x, y, r: 4, life: 1 });
  for (let i = 0; i < 30 * n; i++) fx.fire.push({ x: x + rand(-8, 8), y: y + rand(-6, 6), vx: rand(-.12, .12), vy: rand(-.16, -.02), r: rand(5, 13), life: 1, decay: rand(.0008, .0016) });
  const hull = ['#e8ecf4', '#c7ccd6', '#6b7280', PILOTS[flight.pilot].color];
  for (let i = 0; i < 22 * n; i++) fx.debris.push({ x, y, vx: rand(-.42, .42), vy: rand(-.75, -.15), a: rand(0, Math.PI * 2), spin: rand(-.02, .02), w: rand(3, 8), h: rand(2, 5), color: hull[i % hull.length], life: 1 });
}
// Landing: confetti burst from the lander plus a shower across the pane, and the pad lights up.
function celebrate(flight) {
  const fx = flight.fx, d = flight.display, n = REDUCED_MOTION ? .25 : 1, { width } = flight.view;
  fx.padGlow = 1;
  for (let i = 0; i < 80 * n; i++) fx.confetti.push({ world: true, x: d.x + rand(-6, 6), y: d.y - 8, vx: rand(-.32, .32), vy: rand(-.85, -.3), a: rand(0, 6.3), spin: rand(-.012, .012), phase: rand(0, 6.3), w: rand(3, 6), h: rand(6, 11), color: CONFETTI_COLORS[i % CONFETTI_COLORS.length], life: 1 });
  for (let i = 0; i < 70 * n; i++) fx.confetti.push({ world: false, x: rand(0, width), y: rand(-160, -10), vx: rand(-.03, .03), vy: rand(.07, .16), a: rand(0, 6.3), spin: rand(-.008, .008), phase: rand(0, 6.3), w: rand(4, 7), h: rand(7, 12), color: CONFETTI_COLORS[i % CONFETTI_COLORS.length], life: 1 });
}
function updateEffects(flight, dt) {
  const fx = flight.fx;
  fx.flash = Math.max(0, fx.flash - dt * .004); fx.padGlow = Math.max(0, fx.padGlow - dt * .00025);
  fx.rings.forEach((r) => { r.r += dt * .28; r.life -= dt * .0016; }); fx.rings = fx.rings.filter((r) => r.life > 0);
  fx.fire.forEach((f) => { f.x += f.vx * dt; f.y += f.vy * dt; f.vy -= .00004 * dt; f.r += dt * .012; f.life -= f.decay * dt; }); fx.fire = fx.fire.filter((f) => f.life > 0);
  fx.debris.forEach((p) => {
    p.vy += .0011 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.a += p.spin * dt; p.life -= dt * .00032;
    const ground = P.groundAt(terrain, p.x).y;
    if (p.y > ground - 1) { p.y = ground - 1; p.vy *= -.32; p.vx *= .6; p.spin *= .5; }
  });
  fx.debris = fx.debris.filter((p) => p.life > 0);
  fx.confetti.forEach((c) => {
    if (c.world) { c.vy += .0009 * dt; c.vx *= .995; c.vy = Math.min(c.vy, .12); } // burst, then flutter down
    c.phase += dt * .01; c.x += (c.vx + Math.sin(c.phase) * .03) * dt; c.y += c.vy * dt; c.a += c.spin * dt; c.life -= dt * .00028;
  });
  fx.confetti = fx.confetti.filter((c) => c.life > 0 && (c.world || c.y < flight.view.height + 20));
}
function drawEffects(flight, ctx, screen, scale) {
  const fx = flight.fx;
  fx.rings.forEach((r) => { const p = screen(r); ctx.globalAlpha = r.life * .7; ctx.strokeStyle = '#fdba8c'; ctx.lineWidth = 3 * r.life + .5; ctx.beginPath(); ctx.arc(p.x, p.y, r.r * scale, 0, Math.PI * 2); ctx.stroke(); });
  fx.fire.forEach((f) => {
    const p = screen(f), hot = f.life > .55, k = hot ? (f.life - .55) / .45 : 0;
    ctx.globalAlpha = Math.min(1, f.life * 1.4) * (hot ? .95 : .55);
    ctx.fillStyle = hot ? (k > .6 ? '#fff1c1' : k > .3 ? '#fdba8c' : '#fa935b') : f.life > .3 ? '#6b7280' : '#374151';
    ctx.beginPath(); ctx.arc(p.x, p.y, f.r * scale, 0, Math.PI * 2); ctx.fill();
  });
  fx.debris.forEach((d) => { const p = screen(d); ctx.globalAlpha = Math.min(1, d.life * 2); ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(d.a); ctx.fillStyle = d.color; ctx.fillRect(-d.w * scale / 2, -d.h * scale / 2, d.w * scale, d.h * scale); ctx.restore(); });
  fx.confetti.forEach((c) => { if (!c.world) return; drawConfetto(ctx, screen(c), c, scale); });
  ctx.globalAlpha = 1;
}
function drawConfetto(ctx, p, c, scale) {
  ctx.globalAlpha = Math.min(1, c.life * 2.2);
  ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(c.a); ctx.scale(1, Math.cos(c.phase)); // flip as it flutters
  ctx.fillStyle = c.color; ctx.fillRect(-c.w * scale / 2, -c.h * scale / 2, c.w * scale, c.h * scale); ctx.restore();
}

// ---------------------------------------------------------------- touchdown and mission end
function finishFlight(flight, touchdown) {
  flight.simEnded = true; flight.touchdown = touchdown;
  Object.assign(flight.record, { status: 'done', landed: touchdown.safe, soft: touchdown.soft, reason: touchdown.outcome === 'crashed' ? 'impact' : touchdown.outcome, padOffset: touchdown.padOffset, vx: touchdown.vx, vy: touchdown.vy, tilt: touchdown.a, fuel: Math.max(0, flight.ship.fuel), simSeconds: flight.missionClock });
}
function touchdownText(t) {
  if (t.safe) return 'Landing gear absorbed the touchdown. Pad secured.';
  if (t.soft) return `Safe touchdown, but ${Math.abs(t.padOffset).toFixed(0)} m from the pad center, outside the landing zone. The craft is intact; the mission does not count.`;
  if (Math.abs(t.vy) >= P.SAFE_VY || Math.abs(t.vx) >= P.SAFE_VX) return `Impact at ${Math.abs(t.vy).toFixed(2)} m/s down, ${Math.abs(t.vx).toFixed(2)} m/s sideways.`;
  if (Math.abs(t.a) >= P.SAFE_TILT) return `Touched down tilted ${(Math.abs(t.a) * 180 / Math.PI).toFixed(0)}° and tipped over.`;
  return `Touched down on a ${(Math.abs(t.slope) * 180 / Math.PI).toFixed(0)}° slope and tipped over.`;
}
const outcomeLabel = (t) => (t.safe ? 'LANDED' : t.soft ? 'LANDED OFF PAD' : 'CRASHED');
function showTouchdown(flight) {
  flight.displayEnded = true;
  const t = flight.touchdown;
  for (let i = 0; i < 28; i++) flight.dust.push({ x: t.x, y: t.groundY, vx: (noise(i + Date.now()) - .5) * 2.5, vy: -noise(i * 2) * 1.6, life: 1 });
  flight.shake = REDUCED_MOTION ? 0 : t.safe ? 2 : 18;
  if (t.safe) celebrate(flight); else if (!t.soft) explode(flight);
  const badge = flight.view.fields.result;
  badge.hidden = false; badge.className = `pane-result ${t.safe ? 'is-landed' : t.soft ? 'is-offpad' : 'is-crashed'}`;
  badge.innerHTML = `<b>${outcomeLabel(t)}</b><span>miss ${Math.abs(t.padOffset).toFixed(1)} m · V ${Math.abs(t.vy).toFixed(2)} · fuel ${Math.max(0, Math.round(t.fuel))}%</span>`;
  if (flights.every((f) => f.displayEnded)) endMission();
}
function endMission() {
  if (missionEnding) return;
  missionEnding = true; running = false;
  document.body.classList.remove('is-playing'); document.body.classList.add('is-finished');
  const finished = recordMission();
  const n = campaign.current ? campaign.current.missions.length : 0;
  const summary = flights.map((f) => `${PILOTS[f.pilot].label} ${f.touchdown.safe ? 'landed' : f.touchdown.soft ? 'off pad' : 'crashed'}`).join(' · ');
  const allLanded = flights.every((f) => f.touchdown.safe), noneLanded = flights.every((f) => !f.touchdown.safe);
  $('outcome').hidden = false;
  $('outcome-kicker').textContent = `MISSION ${pad2(n)} / ${campaignSize()}`;
  $('outcome-title').textContent = flights.length > 1 ? summary.toUpperCase() : allLanded ? 'SOFT LANDING' : flights[0].touchdown.soft ? 'OFF-PAD LANDING' : 'MISSION LOST';
  $('outcome-copy').textContent = flights.length > 1 ? 'Both pilots flew the same pad and launch.' : touchdownText(flights[0].touchdown);
  $('retry').hidden = !finished;
  setStatus(allLanded ? 'LANDING COMPLETE' : noneLanded ? 'CRASH DETECTED' : 'SPLIT RESULT', summary);
  if (finished) {
    const totals = campaign.current.pilots.map((p) => `${PILOTS[p].label} ${campaign.current.missions.filter((m) => m.pilots[p]?.landed).length}/${campaign.current.total}`).join(' · ');
    $('outcome-title').textContent = 'CAMPAIGN COMPLETE'; $('outcome-copy').textContent = `${totals} landed.`;
    $('start').disabled = false; $('pause').disabled = true; setBatchLocked(false);
    return;
  }
  const serial = missionSerial;
  advanceTimer = setTimeout(() => { if (serial === missionSerial && campaign.current && !paused) launchMission(); }, Math.max(EFFECTS_MS, NEXT_MISSION_DELAY_MS / speedFactor()));
}

// ---------------------------------------------------------------- decision feed / telemetry panel
function showDecision(pilot, data) {
  $('panel-action').textContent = `${PILOTS[pilot].label} · ${data.action.toUpperCase()}`;
  $('request-id').textContent = `REQ ${data.requestId.slice(0, 8)}`;
  $('raw-output').textContent = JSON.stringify(data.rawProviderOutput, null, 2);
  const list = $('decision-feed'); if (list.querySelector('.empty')) list.replaceChildren();
  const row = document.createElement('li');
  row.innerHTML = `<time>${new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })}</time><b><i class="feed-pilot" style="--pilot:${PILOTS[pilot].color}">${PILOTS[pilot].label}</i>${data.action.toUpperCase()}</b><span>${data.latencyMs}ms</span>`;
  list.prepend(row); while (list.children.length > 6) list.lastElementChild.remove();
  calls++; $('feed-count').textContent = `${pad2(calls)} CALLS`;
}
function setStatus(title, detail) { $('status').textContent = title; $('status-detail').textContent = detail; }
function updateHud(flight) {
  const d = flight.display, f = flight.view.fields, ground = P.groundAt(terrain, d.x);
  const alt = Math.max(0, ground.y - d.y - P.SHIP_FOOT), off = d.x - (terrain.padCenter ?? PAD_CENTER);
  f.alt.textContent = `${String(Math.round(alt)).padStart(4, '0')} M`;
  f.vel.textContent = `V ${d.vy >= 0 ? '+' : ''}${d.vy.toFixed(2)} / H ${d.vx.toFixed(2)}`;
  f.fuel.textContent = `${Math.max(0, Math.round(d.fuel))}%`;
  f.off.textContent = `${off >= 0 ? '+' : ''}${Math.round(off)} M`;
  f.cmd.textContent = d.command.toUpperCase();
  if (flight === flights[0]) { $('phase').textContent = alt < 95 ? 'LANDING' : alt < 270 ? 'DESCENT' : 'APPROACH'; $('slope').textContent = `${(ground.slope * 180 / Math.PI).toFixed(2)}°`; }
}

// ---------------------------------------------------------------- tech specification
const escapeHtml = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function recordRequest(flight, data) {
  if (!data.request) return;
  lastRequests[flight.pilot] = data;
  $(`spec-request-${flight.pilot}`).textContent = JSON.stringify(data.request, null, 2);
  $(`spec-endpoint-${flight.pilot}`).textContent = data.endpoint ? `→ ${data.endpoint.replace(/^(https?:\/\/[^/]{0,12})[^/]*/, '$1…')}` : '';
  // The first decision of a mission comes from the same snapshot for every pilot: compare them.
  if (!firstRequests[flight.pilot]) firstRequests[flight.pilot] = data.request;
  const pilots = Object.keys(firstRequests);
  if (flights.length > 1 && pilots.length === flights.length) {
    const content = (r) => JSON.stringify({ state: r.state, questions: r.questions });
    const same = pilots.every((p) => content(firstRequests[p]) === content(firstRequests[pilots[0]]));
    const check = $('spec-identical');
    check.className = `spec-check ${same ? 'is-ok' : 'is-diff'}`;
    check.textContent = same
      ? `✓ Mission ${pad2(campaign.current?.missions.length || 0)}, first decision: state and questions sent to ${pilots.map((p) => PILOTS[p].label).join(' and ')} are byte-identical (${content(firstRequests[pilots[0]]).length} bytes). Only endpoint, auth header and model name differ.`
      : '✗ First-decision requests differ between models. This should not happen; check the adapter.';
  }
}
// ---- decision-input examples
const CONTROL_LABELS = { thrust: 'BRAKE', left_thrust: 'PUSH LEFT', right_thrust: 'PUSH RIGHT', coast: 'COAST' };
const QUESTION_LABELS = { brake: 'Brake now?', go_right: 'Push right?', go_left: 'Push left?' };
let specExamples = [], exampleAnswers = {}, currentExample = null;
function renderExampleTabs() {
  $('example-tabs').innerHTML = specExamples.map((e, i) => `<button type="button" role="tab" data-example="${escapeHtml(e.id)}"><small>${pad2(i + 1)}</small>${escapeHtml(e.title)}</button>`).join('');
  $('example-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => showExample(b.dataset.example)));
}
function showExample(id) {
  const e = specExamples.find((x) => x.id === id); if (!e) return;
  currentExample = id;
  $('example-tabs').querySelectorAll('button').forEach((b) => { const on = b.dataset.example === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  const t = e.telemetry, side = t.padOffset < 0 ? 'right' : 'left';
  const texts = (mode) => Object.entries(e.requests[mode].state).map(([k, v]) => `<p class="example-label">${escapeHtml(k)}</p><blockquote>${escapeHtml(v)}</blockquote>`).join('');
  // Answer columns: the plan, then each model that has been asked, per mode.
  const cols = [];
  for (const pilot of Object.keys(PILOTS)) for (const mode of ['binary', 'facts']) { const a = exampleAnswers[mode]?.[id]?.[pilot]; if (a) cols.push({ label: `${PILOTS[pilot].label} ${mode === 'binary' ? 'guided' : 'facts'}`, a }); }
  const score = (a, key) => { const v = a.scores?.[key]; return typeof v === 'number' ? `<b class="${v >= .5 ? 'is-yes' : 'is-no'}">${v.toFixed(2)}</b>` : '<span>—</span>'; };
  $('example-view').innerHTML = `
    <div class="example-col example-state">
      <h4>Flight state</h4>
      <dl class="example-telemetry">
        <div><dt>Altitude</dt><dd>${t.altitude} m</dd></div>
        <div><dt>Vertical speed</dt><dd>${t.verticalVelocity} m/s ${t.verticalVelocity >= 0 ? 'down' : 'up'}</dd></div>
        <div><dt>Sideways speed</dt><dd>${Math.abs(t.horizontalVelocity) < .05 ? 'none' : `${Math.abs(t.horizontalVelocity)} m/s ${t.horizontalVelocity > 0 ? 'right' : 'left'}`}</dd></div>
        <div><dt>Pad</dt><dd>${Math.abs(t.padOffset) < 5 ? 'directly below' : `${Math.abs(t.padOffset)} m to the ${side}`}</dd></div>
      </dl>
    </div>
    <div class="example-col example-input"><h4>Guided text</h4>${texts('binary')}</div>
    <div class="example-col example-input"><h4>Facts-only text</h4>${texts('facts')}</div>
    <div class="example-col example-result">
      <h4>Answers → control</h4>
      <div class="example-answers" style="--cols:${1 + cols.length}">
        <div class="example-answer-row example-answer-head"><span></span><span>Plan</span>${cols.map((c) => `<span>${c.label}</span>`).join('')}</div>
        ${['brake', 'go_right', 'go_left'].map((k) => `<div class="example-answer-row"><span>${QUESTION_LABELS[k]}</span><b class="${e.expected[k] ? 'is-yes' : 'is-no'}">${e.expected[k] ? 'yes' : 'no'}</b>${cols.map((c) => score(c.a, k)).join('')}</div>`).join('')}
        <div class="example-answer-row example-control"><span>Control</span><b>${CONTROL_LABELS[e.control]}</b>${cols.map((c) => `<b class="${c.a.choice === e.control ? 'is-yes' : 'is-no'}">${c.a.choice ? CONTROL_LABELS[c.a.choice] : '—'}</b>`).join('')}</div>
      </div>
      <p class="example-questions-note">The three yes/no questions are the same in both modes; each answer is a score from 0 to 1, and 0.5 or more counts as yes.${cols.length ? '' : ' Press ASK THE MODELS to add real scores.'}</p>
    </div>
    <details class="example-json"><summary>Exact request bodies (JSON)</summary><div class="example-json-pair"><pre>${escapeHtml(JSON.stringify(e.requests.binary, null, 2))}</pre><pre>${escapeHtml(JSON.stringify(e.requests.facts, null, 2))}</pre></div></details>`;
}
// Sends every example, in both modes, to each model that has a key, through the same relay the flights use.
async function runExamples() {
  const pilots = Object.keys(PILOTS).filter((p) => connectionFor(p).token);
  if (!pilots.length) { $('run-examples-status').textContent = 'Add a Laya or JEV key at the top first.'; return; }
  $('run-examples').disabled = true; $('run-examples-status').textContent = `Asking ${pilots.map((p) => PILOTS[p].label).join(' and ')}…`;
  const briefing = settings.briefing.trim(); let failed = false;
  await Promise.all(specExamples.flatMap((e) => pilots.flatMap((pilot) => ['binary', 'facts'].map(async (mode) => {
    try {
      const response = await fetch('/api/lander/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ telemetry: e.fullTelemetry, connection: { ...connectionFor(pilot), variant: mode }, briefing: mode === 'facts' ? briefing : '' }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      const answers = data.rawProviderOutput?.answers || {};
      ((exampleAnswers[mode] ||= {})[e.id] ||= {})[pilot] = { choice: data.action, scores: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v?.noul])) };
    } catch (error) { failed = true; $('run-examples-status').textContent = `${PILOTS[pilot].label}: ${error.message}`; }
  }))));
  if (!failed) {
    const tally = (mode) => { const r = specExamples.flatMap((e) => pilots.map((p) => exampleAnswers[mode]?.[e.id]?.[p]).filter(Boolean).map((a) => a.choice === e.control)); return `${r.filter(Boolean).length}/${r.length}`; };
    $('run-examples-status').textContent = `Matches the plan: guided ${tally('binary')}, facts only ${tally('facts')}${briefing ? ' (with the current briefing)' : ''}.`;
  }
  $('run-examples').disabled = false; showExample(currentExample);
}
async function loadSpec() {
  let spec;
  try { spec = await (await fetch('/api/lander/spec')).json(); } catch { return; }
  $('spec-providers').innerHTML = `<div class="spec-row spec-head"><span></span>${spec.providers.map((p) => `<span>${escapeHtml(p.label)}</span>`).join('')}</div>`
    + [['Endpoint', 'endpoint'], ['Auth header', 'auth'], ['Model', 'model']].map(([label, key]) => `<div class="spec-row"><span>${label}</span>${spec.providers.map((p) => `<span><code>${escapeHtml(p[key])}</code></span>`).join('')}</div>`).join('')
    + `<div class="spec-row"><span>Body</span>${spec.providers.map(() => '<span><code>state</code> + <code>questions</code> (identical)</span>').join('')}</div>`;
  specExamples = spec.examples || []; renderExampleTabs(); showExample(specExamples[0]?.id);
  $('spec-mapping').innerHTML = `Mapping: if <code>brake ≥ ${spec.thresholds.brake}</code> → <code>thrust</code>; else if the higher of <code>go_right</code> / <code>go_left</code> is <code>≥ ${spec.thresholds.sideways}</code> → <code>right_thrust</code> / <code>left_thrust</code>; otherwise <code>coast</code>.`;
  const g = spec.guidance;
  $('spec-guidance').innerHTML = [
    `<b>Brake</b> when the stopping distance exceeds the altitude minus 5 m. Stopping distance = the drop during a ${g.DECISION_LAG_S} s decision lag (gravity ${g.GRAVITY} m/s² included) plus braking from the speed reached then, at ${g.BRAKE_DECELERATION} m/s².`,
    `<b>Brake</b> whenever the descent exceeds <b>${g.MAX_DESCENT} m/s</b>.`,
    `<b>Brake</b> when more than ${g.FAR_FROM_PAD} m from the pad, falling faster than ${g.FAR_DESCENT} m/s, and the craft would reach ${g.LOW_ALTITUDE} m altitude before reaching the pad.`,
    `<b>Sideways target speed</b> toward the pad = min(distance / 8, √(2 · ${g.LATERAL_BRAKE} · distance), ${g.MAX_LATERAL}) m/s. A push is requested beyond ±1.5 m/s of the target (±1.0 below 80 m).`,
    `<b>Final descent</b> below ${g.FINAL_DESCENT_ALTITUDE} m: no sideways burns, so the craft stays upright for touchdown.`
  ].map((t) => `<li>${t}</li>`).join('');
  $('spec-physics').innerHTML = [
    `Gravity <b>${P.LUNAR_GRAVITY} m/s²</b> · main engine <b>${P.ENGINE_ACCELERATION} m/s²</b> · translation burn <b>${P.DIRECTIONAL_ACCELERATION} m/s²</b> · simulation clock <b>×${P.SIMULATION_TIME_SCALE}</b>`,
    `Maneuvers are attitude-hold: translation burns tilt to <b>±${P.MANEUVER_TILT} rad</b>, slewing at ${P.SLEW_RATE} rad/s. <code>coast</code> slews upright.`,
    `<code>thrust</code> brakes upright. It throttles down near <b>${P.BRAKE_FLOOR_VY} m/s</b> descent so it never climbs, and leans up to ${P.DRIFT_TILT} rad against sideways drift.`,
    `Soft touchdown: vertical speed &lt; ${P.SAFE_VY} m/s, horizontal &lt; ${P.SAFE_VX} m/s, tilt &lt; ${P.SAFE_TILT} rad, ground slope &lt; ${P.MAX_LANDING_SLOPE} rad (the pad is flat). Soft on the pad (±${P.PAD_HALF_WIDTH} m) = <b>landed</b>; soft elsewhere = <b>off-pad landing</b> (intact, not a success); otherwise = <b>crash</b>.`,
    `Random missions: pad between x = ${P.PAD_MIN} and ${P.PAD_MAX}, launch 150–600 m to either side.`
  ].map((t) => `<li>${t}</li>`).join('');
  $('spec-briefing-max').textContent = String(spec.maxBriefingLength);
}

// ---------------------------------------------------------------- drawing
function drawFlight(flight) {
  const { ctx, width, height, scale } = flight.view;
  if (!width || !height) return;
  const cam = flight.camera, d = flight.display;
  const screen = (p) => ({ x: (p.x - cam.x) * scale + width / 2, y: (p.y - cam.y) * scale + height / 2 });
  ctx.clearRect(0, 0, width, height);
  const sx = flight.shake ? (Math.random() - .5) * flight.shake : 0, sy = flight.shake ? (Math.random() - .5) * flight.shake : 0; flight.shake *= .88;
  ctx.save(); ctx.translate(sx, sy);
  const sky = ctx.createLinearGradient(0, 0, 0, height); sky.addColorStop(0, '#232936'); sky.addColorStop(.7, '#181d27'); ctx.fillStyle = sky; ctx.fillRect(-20, -20, width + 40, height + 40);
  stars.forEach((star) => { const p = screen(star); if (p.x > -5 && p.x < width + 5 && p.y > -5 && p.y < height) { ctx.globalAlpha = .2 + star.z * .6; ctx.fillStyle = star.z > .72 ? '#ffffff' : '#9ca3af'; ctx.fillRect(p.x, p.y, star.r, star.r); } }); ctx.globalAlpha = 1;
  const first = screen(terrain[0]); ctx.beginPath(); ctx.moveTo(first.x, first.y); for (let i = 1; i < terrain.length; i++) { const p = screen(terrain[i]); ctx.lineTo(p.x, p.y); }
  ctx.lineTo(width + 30, height + 30); ctx.lineTo(-30, height + 30); ctx.closePath();
  const soil = ctx.createLinearGradient(0, height * .55, 0, height); soil.addColorStop(0, '#9ca3af'); soil.addColorStop(1, '#232833'); ctx.fillStyle = soil; ctx.fill(); ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 2; ctx.stroke();
  const pad = terrain.padCenter ?? PAD_CENTER, padY = terrain.padY ?? terrainY(pad), left = screen({ x: pad - PAD_HALF_WIDTH, y: padY }), right = screen({ x: pad + PAD_HALF_WIDTH, y: padY });
  ctx.save(); ctx.setLineDash([7, 8]); ctx.strokeStyle = '#fa935b55'; ctx.lineWidth = 1;
  [pad - PAD_HALF_WIDTH, pad + PAD_HALF_WIDTH].forEach((x) => { const top = screen({ x, y: padY - 560 }), bottom = screen({ x, y: padY }); ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bottom.x, bottom.y); ctx.stroke(); });
  const glow = flight.fx.padGlow, padColor = glow > 0 ? '#4ade80' : '#fa935b';
  ctx.restore(); ctx.strokeStyle = padColor; ctx.shadowColor = padColor; ctx.shadowBlur = 13 + glow * 30 * (.6 + .4 * Math.sin(performance.now() * .012)); ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(left.x, left.y - 2); ctx.lineTo(right.x, right.y - 2); ctx.stroke(); ctx.shadowBlur = 0;
  const from = screen(d), to = screen({ x: pad, y: padY - P.SHIP_FOOT });
  ctx.save(); ctx.setLineDash([4, 7]); ctx.lineDashOffset = -performance.now() * .025; ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = '#fdba8c'; ctx.beginPath(); ctx.arc(to.x, to.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  flight.trail.forEach((particle) => { const p = screen(particle); ctx.globalAlpha = particle.life; ctx.fillStyle = '#fdba8c'; ctx.beginPath(); ctx.arc(p.x, p.y, (2 + (1 - particle.life) * 5) * scale, 0, 7); ctx.fill(); });
  flight.dust.forEach((particle) => { const p = screen(particle); ctx.globalAlpha = particle.life; ctx.fillStyle = '#d0d1d7'; ctx.fillRect(p.x, p.y, 2, 2); }); ctx.globalAlpha = 1;
  drawEffects(flight, ctx, screen, scale);
  const p = screen(d);
  if (flight.fx.exploded) { ctx.restore(); drawOverlayEffects(flight, ctx, width, height, scale); return; }
  ctx.save(); ctx.translate(p.x, p.y); ctx.scale(scale, scale); ctx.rotate(d.a);
  if (d.burning && !flight.displayEnded) { ctx.fillStyle = '#fa935b'; ctx.beginPath(); ctx.moveTo(-6, 15); ctx.lineTo(0, 31 + Math.random() * 8); ctx.lineTo(6, 15); ctx.fill(); }
  ctx.fillStyle = '#e8ecf4'; ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, -17); ctx.lineTo(12, 10); ctx.lineTo(8, 16); ctx.lineTo(-8, 16); ctx.lineTo(-12, 10); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = PILOTS[flight.pilot].color; ctx.fillRect(-4, -7, 8, 7);
  ctx.strokeStyle = '#e8ecf4'; ctx.beginPath(); ctx.moveTo(-8, 13); ctx.lineTo(-15, 21); ctx.moveTo(8, 13); ctx.lineTo(15, 21); ctx.stroke();
  ctx.restore(); ctx.restore();
  drawOverlayEffects(flight, ctx, width, height, scale);
}
// Screen-space layer: the confetti shower and the explosion flash, unaffected by camera shake.
function drawOverlayEffects(flight, ctx, width, height, scale) {
  const fx = flight.fx;
  fx.confetti.forEach((c) => { if (!c.world) drawConfetto(ctx, c, c, Math.max(scale, .8)); });
  if (fx.flash > 0) { ctx.globalAlpha = fx.flash * .45; ctx.fillStyle = '#fdba8c'; ctx.fillRect(0, 0, width, height); }
  ctx.globalAlpha = 1;
}
function draw() { flights.forEach(drawFlight); requestAnimationFrame(draw); }

// ---------------------------------------------------------------- main loop
function loop(now) {
  const dt = Math.min(35, now - last || 16); last = now;
  if (running && !paused) {
    for (const flight of flights) { simulate(flight, dt); playback(flight, dt); updateHud(flight); }
    boardClock += dt;
    if (mission && boardClock >= 300 && !missionEnding) { boardClock = 0; CampaignBoard.renderActive(mission, campaign.current.missions.length - 1, campaignSize(), P, campaign.current.pilots); }
  } else if (missionEnding) {
    for (const flight of flights) playback(flight, dt);
  }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- campaign flow
function saveCampaign() { try { localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(campaign)); } catch { /* storage unavailable: results stay in memory */ } }
// Older saves stored one Laya result per mission; wrap them in the per-pilot shape.
function migrateMission(m) {
  if (m.pilots) return m;
  const { padCenter, launch, launchOffset, startedAt, status, ...result } = m;
  return { padCenter, launch, launchOffset, startedAt, status, pilots: { laya: { ...result, status } } };
}
function loadCampaign() {
  try {
    const saved = JSON.parse(localStorage.getItem(CAMPAIGN_STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') campaign = { current: saved.current || null, history: Array.isArray(saved.history) ? saved.history : [] };
  } catch { campaign = { current: null, history: [] }; }
  if (campaign.current) {
    campaign.current.pilots ||= ['laya'];
    // A mission left in flight by a page reload never finished; drop it.
    campaign.current.missions = campaign.current.missions.map(migrateMission).filter((m) => m.status !== 'active');
  }
  campaign.history = campaign.history.map((h) => (h.results ? h : { ...h, results: { laya: { landed: h.landed, avgMiss: h.avgMiss } } }));
}
function setBatchLocked(locked) {
  $('mission-count').disabled = locked; $('briefing').disabled = locked;
  document.querySelectorAll('#briefing-examples button').forEach((b) => { b.disabled = locked; });
  document.querySelectorAll('#prompt-control button').forEach((b) => { b.disabled = locked; });
  document.querySelectorAll('#pilot-control button').forEach((b) => { b.disabled = locked; });
}
function startCampaign() {
  const missing = missingKeys();
  if (missing.length) { setStatus('API KEY REQUIRED', `Add the ${missing.join(' and ')} API key at the top before launching.`); return; }
  clearTimeout(advanceTimer);
  campaign.current = { id: Date.now().toString(36), startedAt: Date.now(), total: settings.missions, pilots: activePilots(), briefing: settings.prompt === 'facts' ? settings.briefing.trim() : '', prompt: settings.prompt, missions: [] };
  setBatchLocked(true); saveCampaign(); CampaignBoard.render(campaign, P); launchMission();
}
function launchMission() {
  resetGame();
  const plan = P.randomMission();
  terrain = P.makeTerrain(plan.padCenter); firstRequests = {};
  mission = { status: 'active', padCenter: plan.padCenter, launch: plan.ship, launchOffset: plan.ship.x - plan.padCenter, startedAt: Date.now(), pilots: {} };
  flights = campaign.current.pilots.map((pilot) => {
    const record = mission.pilots[pilot] = { status: 'active', counts: {}, path: [[Math.round(plan.ship.x), Math.round(plan.ship.y)]], fuel: 100, simSeconds: 0 };
    return createFlight(pilot, plan.ship, record);
  });
  buildPanes();
  campaign.current.missions.push(mission); CampaignBoard.render(campaign, P);
  setStatus(`MISSION ${pad2(campaign.current.missions.length)} / ${campaignSize()}`, `New landing zone ${Math.abs(Math.round(mission.launchOffset))} m to the ${mission.launchOffset < 0 ? 'right' : 'left'}.`);
  start();
}
// Returns true when this mission completed the campaign.
function recordMission() {
  if (!mission || !campaign.current) return false;
  mission.status = 'done'; mission.finishedAt = Date.now(); mission = null;
  const current = campaign.current, finished = current.missions.length >= current.total;
  if (finished) {
    const results = Object.fromEntries(current.pilots.map((pilot) => {
      const landed = current.missions.map((m) => m.pilots[pilot]).filter((r) => r?.landed);
      return [pilot, { landed: landed.length, avgMiss: landed.length ? landed.reduce((n, r) => n + Math.abs(r.padOffset), 0) / landed.length : null }];
    }));
    campaign.history.unshift({ id: current.id, finishedAt: Date.now(), total: current.total, briefing: current.briefing || '', prompt: current.prompt || 'binary', results });
    campaign.history = campaign.history.slice(0, 20);
  }
  saveCampaign(); CampaignBoard.render(campaign, P);
  return finished;
}
function abortCampaign() {
  setBatchLocked(false);
  if (mission && campaign.current) campaign.current.missions = campaign.current.missions.filter((m) => m !== mission);
  mission = null; saveCampaign(); CampaignBoard.render(campaign, P);
}

// ---------------------------------------------------------------- game state
function resetGame() {
  clearTimeout(advanceTimer); missionSerial++; running = false; paused = false; missionEnding = false;
  document.body.classList.remove('is-playing', 'is-finished');
  countdownUntil = 0; calls = 0; $('feed-count').textContent = '00 CALLS';
  $('decision-feed').innerHTML = '<li class="empty">Live model commands appear after launch.</li>';
  $('outcome').hidden = true; $('countdown').hidden = true; $('pause').disabled = true; $('pause').textContent = 'PAUSE'; $('start').disabled = false;
  $('request-id').textContent = 'NO REQUEST'; $('raw-output').textContent = 'Provider response is redacted before display.'; $('retry').hidden = false;
  flights = activePilots().map((pilot) => createFlight(pilot, undefined, { counts: {}, path: [] }));
  buildPanes();
  setStatus('READY FOR LAUNCH', `Objective: ${campaignSize()} missions, each with a new landing zone. Land soft and level on the pad.`);
}
function start() {
  document.body.classList.add('is-playing'); flights[0]?.view.canvas.focus({ preventScroll: true });
  $('start').disabled = true; $('pause').disabled = false; $('countdown').hidden = false; $('countdown').textContent = 'LAUNCH';
  const launchId = performance.now(); countdownUntil = launchId;
  setTimeout(() => {
    if (countdownUntil !== launchId) return;
    $('countdown').hidden = true; running = true; paused = false;
    flights.forEach((f) => { f.nextDecision = performance.now(); });
  }, Math.max(150, 650 / speedFactor()));
}
function togglePause() {
  if (!running && !paused) return;
  paused = !paused; $('pause').textContent = paused ? 'RESUME' : 'PAUSE';
  if (!paused) {
    if (missionEnding && campaign.current && campaign.current.missions.length < campaign.current.total) { launchMission(); return; }
    running = true;
    // Retry any decision that failed while paused.
    flights.forEach((f) => { f.deciding = false; f.nextDecision = performance.now(); if (f.lock.awaiting) { f.lock.awaiting = false; f.lock.nextDecision = f.gameClock; } });
  }
  setStatus(paused ? 'MISSION PAUSED' : 'FLIGHT RESUMED', paused ? 'Simulation and live control are suspended.' : 'Flight computer active.');
}

// ---------------------------------------------------------------- batch settings
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
    if (SPEEDS[saved.speed]) settings.speed = String(saved.speed);
    if (Number.isInteger(saved.missions)) settings.missions = Math.max(1, Math.min(MAX_MISSIONS, saved.missions));
    if (PILOT_MODES[saved.pilots]) settings.pilots = saved.pilots;
    if (typeof saved.briefing === 'string') settings.briefing = saved.briefing.slice(0, 500);
    if (PROMPT_LABELS[saved.prompt]) settings.prompt = saved.prompt;
  } catch { /* defaults */ }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ } }
function renderSettings() {
  $('mission-count').value = String(settings.missions);
  if ($('briefing').value !== settings.briefing) $('briefing').value = settings.briefing;
  $('briefing-section').hidden = settings.prompt !== 'facts';
  document.querySelectorAll('#briefing-examples button[data-example]').forEach((b) => b.classList.toggle('active', BRIEFING_EXAMPLES[b.dataset.example].text === settings.briefing.trim()));
  $('briefing-count').textContent = `${settings.briefing.length} / 500`;
  const mark = (selector, attr, value) => document.querySelectorAll(`${selector} button`).forEach((b) => { const on = b.dataset[attr] === value; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
  mark('#speed-control', 'speed', settings.speed); mark('#pilot-control', 'pilots', settings.pilots); mark('#prompt-control', 'prompt', settings.prompt);
  const label = `${settings.missions} MISSION${settings.missions === 1 ? '' : 'S'}`;
  $('start').textContent = `START ${label}`; $('retry').textContent = `RUN ${label} AGAIN`;
  const duel = settings.pilots === 'duel';
  $('autopilot').disabled = duel; if (duel && !autopilot) toggleAutopilot();
}
function setSpeed(speed) {
  const wasLockstep = lockstep();
  settings.speed = speed; saveSettings(); renderSettings();
  for (const f of flights) {
    if (wasLockstep && !lockstep()) { f.lock.awaiting = false; f.lock.pending = null; f.deciding = false; f.nextDecision = performance.now(); f.frames = [f.frames[f.frames.length - 1]]; }
    if (!wasLockstep && lockstep()) { f.lock.nextDecision = f.gameClock; f.lock.pending = null; f.playing = false; f.production = []; }
  }
}
function setPilots(mode) {
  if (running || (campaign.current && mission)) return;
  settings.pilots = mode; saveSettings(); renderSettings(); resetGame();
}
function toggleAutopilot() {
  autopilot = !autopilot;
  $('autopilot').classList.toggle('active', autopilot); $('autopilot').setAttribute('aria-pressed', String(autopilot));
  $('manual-hint').textContent = autopilot ? 'MODEL HAS CONTROL' : 'MANUAL CONTROLS ARMED';
}

// ---------------------------------------------------------------- wiring
$('start').addEventListener('click', startCampaign);
$('pause').addEventListener('click', togglePause);
$('reset').addEventListener('click', () => { abortCampaign(); resetGame(); });
$('retry').addEventListener('click', startCampaign);
$('autopilot').addEventListener('click', toggleAutopilot);
document.querySelectorAll('#speed-control button').forEach((b) => b.addEventListener('click', () => setSpeed(b.dataset.speed)));
document.querySelectorAll('#pilot-control button').forEach((b) => b.addEventListener('click', () => setPilots(b.dataset.pilots)));
document.querySelectorAll('#prompt-control button').forEach((b) => b.addEventListener('click', () => { if (running || (campaign.current && mission)) return; settings.prompt = b.dataset.prompt; saveSettings(); renderSettings(); }));
$('mission-count').addEventListener('change', () => { const n = Math.round(Number($('mission-count').value)); settings.missions = Number.isFinite(n) ? Math.max(1, Math.min(MAX_MISSIONS, n)) : 10; saveSettings(); renderSettings(); });
$('run-examples').addEventListener('click', runExamples);
$('briefing-examples').innerHTML = BRIEFING_EXAMPLES.map((e, i) => `<button type="button" data-example="${i}" title="${escapeHtml(e.text)}"><b>${escapeHtml(e.label)}</b><span>${escapeHtml(e.result)}</span>${e.recommended ? '<i>BEST</i>' : ''}</button>`).join('')
  + '<button type="button" class="briefing-clear" id="briefing-clear"><b>Clear</b></button>';
document.querySelectorAll('#briefing-examples button[data-example]').forEach((b) => b.addEventListener('click', () => {
  if ($('briefing').disabled) return;
  $('briefing').value = BRIEFING_EXAMPLES[b.dataset.example].text; $('briefing').dispatchEvent(new Event('input')); $('briefing').focus();
}));
$('briefing-clear').addEventListener('click', () => { if ($('briefing').disabled) return; $('briefing').value = ''; $('briefing').dispatchEvent(new Event('input')); });
$('briefing').addEventListener('input', () => { settings.briefing = $('briefing').value.slice(0, 500); saveSettings(); renderSettings(); });
['base-url', 'api-token', 'jev-key'].forEach((id) => $(id).addEventListener('input', persistConnection));
$('save-connection').addEventListener('click', persistConnection);
$('clear-connection').addEventListener('click', clearConnection);
addEventListener('keydown', (event) => { if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code)) { if (!autopilot) event.preventDefault(); keys[event.code] = true; } });
addEventListener('keyup', (event) => { keys[event.code] = false; });

loadSpec(); makeStars(); restoreConnection(); loadSettings(); renderSettings(); loadCampaign(); CampaignBoard.render(campaign, P); resetGame();
requestAnimationFrame(loop); requestAnimationFrame(draw);
