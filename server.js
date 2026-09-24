'use strict';

// Wizden Moon Lander server: serves the game and relays flight decisions to Laya or JEV.
// The browser never talks to a model directly; API keys pass through per request and are
// redacted from every response. By default the server listens on localhost only, because the
// relay forwards requests to the endpoint the page supplies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { decide, buildRequest, DEFAULT_VARIANT, THRESHOLDS, MAX_BRIEFING_LENGTH, JEV_URL } = require('./src/lander-adapter');
const { constants: GUIDANCE_CONSTANTS, assess } = require('./src/lander-guidance');
const physics = require('./public/lander-physics');

const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 3030);
const host = process.env.HOST || '127.0.0.1';
const CONTENT_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// Canonical flight situations shown as decision-input examples in the tech specification.
const SPEC_EXAMPLES = [
  { id: 'far', title: 'Pad far to the right', ship: { x: 1000, y: 260, vx: 0, vy: 1 } },
  { id: 'away', title: 'Drifting away from the pad', ship: { x: 1650, y: 330, vx: 3, vy: 4 } },
  { id: 'overshoot', title: 'About to overshoot', ship: { x: 1370, y: 420, vx: 10, vy: 6 } },
  { id: 'onplan', title: 'On plan, cruising', ship: { x: 1200, y: 380, vx: 12, vy: 5 } },
  { id: 'brake', title: 'Falling too fast near the ground', ship: { x: 1400, y: 950, vx: 0, vy: 14 } },
  { id: 'final', title: 'Final descent over the pad', ship: { x: 1405, y: 985, vx: .4, vy: 2.2 } }
];

function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 100000) reject(new Error('Request too large.')); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON.')); } });
  });
}
function serveStatic(pathname, res) {
  let requested;
  try { requested = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { return json(res, 400, { error: 'Bad path' }); }
  const file = path.resolve(publicDir, `.${requested}`);
  if (!file.startsWith(publicDir + path.sep)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (error, content) => {
    if (error) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': `${CONTENT_TYPES[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    res.end(content);
  });
}
// Removes the API key from anything echoed back to the page.
function redact(value, secret) {
  if (typeof value === 'string') return secret ? value.split(secret).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = /token|authorization|api.?key|secret/i.test(key) ? '[REDACTED]' : redact(item, secret);
    return result;
  }
  return value;
}
function boundedNumber(value, min = -10000, max = 10000) { const number = Number(value); return Number.isFinite(number) ? Math.round(Math.max(min, Math.min(max, number)) * 100) / 100 : null; }

// Tech specification data, generated from the live modules so the page never drifts from the code.
function spec() {
  const terrain = physics.makeTerrain(), example = physics.telemetry(terrain, physics.createShip());
  return {
    variant: DEFAULT_VARIANT, thresholds: THRESHOLDS, guidance: GUIDANCE_CONSTANTS, maxBriefingLength: MAX_BRIEFING_LENGTH,
    example: { telemetry: example, request: buildRequest(example, DEFAULT_VARIANT) },
    examples: SPEC_EXAMPLES.map(({ id, title, ship }) => {
      const telemetry = physics.telemetry(terrain, physics.createShip(ship)), plan = assess(telemetry);
      const requestFor = (variant) => { const { model, ...request } = buildRequest(telemetry, variant); return request; };
      return {
        id, title, request: requestFor(DEFAULT_VARIANT), requests: { binary: requestFor('binary'), facts: requestFor('facts') }, fullTelemetry: telemetry,
        telemetry: { altitude: +telemetry.altitude.toFixed(1), verticalVelocity: +telemetry.verticalVelocity.toFixed(2), horizontalVelocity: +telemetry.horizontalVelocity.toFixed(2), padOffset: +telemetry.padOffset.toFixed(1), fuel: +telemetry.fuel.toFixed(0) },
        expected: { brake: plan.mustBrake, go_right: plan.lateralNeed === 'push_right', go_left: plan.lateralNeed === 'push_left' },
        control: plan.recommended
      };
    }),
    providers: [
      { id: 'laya', label: 'Laya', endpoint: '<Laya endpoint>/v1/decisions', auth: 'X-API-Key: <token>', model: 'server default (english)' },
      { id: 'jev', label: 'JEV', endpoint: JEV_URL, auth: 'Authorization: Bearer <key>', model: 'jev-latest' }
    ]
  };
}

// Validates a telemetry snapshot from the page into bounded numbers.
function boundTelemetry(telemetry) {
  const bounded = {};
  for (const key of ['altitude', 'verticalVelocity', 'horizontalVelocity', 'orientation', 'padOffset', 'fuel', 'terrainSlope']) {
    const value = Number(telemetry[key]);
    if (!Number.isFinite(value)) throw Object.assign(new Error(`Telemetry ${key} must be a number.`), { status: 400 });
    bounded[key] = Math.round(Math.max(-10000, Math.min(10000, value)) * 100) / 100;
  }
  bounded.phase = ['approach', 'descent', 'landing'].includes(telemetry.phase) ? telemetry.phase : 'approach';
  const ray = telemetry.landingRay;
  if (ray && typeof ray === 'object') {
    bounded.landingRay = {};
    for (const key of ['targetX', 'targetY', 'range', 'deltaX', 'deltaY', 'bearing', 'closingSpeed']) {
      const value = boundedNumber(ray[key]);
      if (value === null) throw Object.assign(new Error(`Landing ray ${key} must be a number.`), { status: 400 });
      bounded.landingRay[key] = value;
    }
  }
  return bounded;
}

async function relayDecision(req, res) {
  const started = performance.now();
  let body;
  try { body = await readBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
  if (!body.telemetry || typeof body.telemetry !== 'object') return json(res, 400, { error: 'A telemetry snapshot is required.' });
  let telemetry;
  try { telemetry = boundTelemetry(body.telemetry); } catch (error) { return json(res, 400, { error: error.message }); }
  const connection = body.connection || {};
  try {
    const result = await decide(telemetry, connection, { briefing: body.briefing });
    return json(res, 200, {
      requestId: crypto.randomUUID(), mode: result.mode, provider: result.provider, action: result.choice, telemetry,
      latencyMs: Math.round(performance.now() - started),
      rawProviderOutput: redact(result.rawProviderOutput, connection.token), request: redact(result.request, connection.token), endpoint: result.endpoint
    });
  } catch (error) {
    return json(res, 502, { error: redact(error.message || 'Lander decision failed.', connection.token) });
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname.replace(/(.)\/$/, '$1');
  if (req.method === 'GET' && pathname === '/api/lander/spec') return json(res, 200, spec());
  if (req.method === 'POST' && pathname === '/api/lander/decide') return relayDecision(req, res).catch(() => json(res, 500, { error: 'Internal error.' }));
  if (req.method === 'GET') return serveStatic(pathname, res);
  return json(res, 405, { error: 'Method not allowed' });
});

if (require.main === module) server.listen(port, host, () => console.log(`Wizden Moon Lander listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
module.exports = { server };
