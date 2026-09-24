'use strict';

// Decision relay shared by the local server (server.js) and the Vercel functions (api/).
// The page sends a telemetry snapshot plus connection details; the relay builds the model
// request, forwards it, and returns the chosen control with API keys redacted.
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const { decide } = require('./lander-adapter');


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


// Validates a telemetry snapshot from the page into bounded numbers.
function boundTelemetry(telemetry) {
  const bounded = {};
  for (const key of ['altitude', 'verticalVelocity', 'horizontalVelocity', 'orientation', 'padOffset', 'fuel', 'terrainSlope']) {
    const value = Number(telemetry[key]);
    if (!Number.isFinite(value)) throw new Error(`Telemetry ${key} must be a number.`);
    bounded[key] = Math.round(Math.max(-10000, Math.min(10000, value)) * 100) / 100;
  }
  bounded.phase = ['approach', 'descent', 'landing'].includes(telemetry.phase) ? telemetry.phase : 'approach';
  const ray = telemetry.landingRay;
  if (ray && typeof ray === 'object') {
    bounded.landingRay = {};
    for (const key of ['targetX', 'targetY', 'range', 'deltaX', 'deltaY', 'bearing', 'closingSpeed']) {
      const value = boundedNumber(ray[key]);
      if (value === null) throw new Error(`Landing ray ${key} must be a number.`);
      bounded.landingRay[key] = value;
    }
  }
  return bounded;
}

// ---- endpoint guard
// Locally the relay may call any endpoint (e.g. a Laya server on this machine). When deployed
// publicly (Vercel sets VERCEL=1, or RELAY_PUBLIC=1), anyone can call the relay, so a Laya endpoint
// must be https and must not resolve to a private, loopback or link-local address. LAYA_ALLOWED_HOSTS
// (comma-separated, "*.trycloudflare.com" style) optionally restricts it further.
const list = (value) => String(value || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
function relayPolicy(env = process.env) {
  return {
    isPublic: Boolean(env.VERCEL) || env.RELAY_PUBLIC === '1',
    allowedHosts: list(env.LAYA_ALLOWED_HOSTS),
    // Extra page origins allowed to use a public relay, besides the deployment's own host.
    allowedOrigins: list(env.RELAY_ALLOWED_ORIGINS).map((o) => o.replace(/\/$/, '')),
    // Decisions per minute per client IP, per function instance (best effort; use Vercel Firewall for a hard limit).
    rateLimit: Math.max(0, Number(env.RELAY_RATE_LIMIT ?? 300) || 0),
    // Model call timeout; kept under the function's 30 s limit so a slow model returns a clean error.
    timeoutMs: Math.max(1000, Number(env.PROVIDER_TIMEOUT_MS) || 25000)
  };
}
function isPrivateAddress(address) {
  const type = net.isIP(address);
  if (type === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (type === 6) {
    const v = address.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(v);
  }
  return true;
}
const hostAllowed = (host, allowed) => allowed.some((rule) => (rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule));
async function checkEndpoint(baseUrl, policy = relayPolicy()) {
  if (!policy.isPublic) return;
  let url;
  try { url = new URL(String(baseUrl || '')); } catch { throw new Error('A valid Laya endpoint is required.'); }
  if (url.protocol !== 'https:') throw new Error('The Laya endpoint must use https.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (policy.allowedHosts.length && !hostAllowed(host, policy.allowedHosts)) throw new Error('This Laya endpoint host is not allowed on this deployment.');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) throw new Error('The Laya endpoint must be a public address.');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (!addresses.length) throw new Error('The Laya endpoint host could not be resolved.');
  if (addresses.some(isPrivateAddress)) throw new Error('The Laya endpoint must be a public address.');
}

// Handles one decision request body. Returns { status, body } for either transport.
async function handleDecision(body, policy = relayPolicy()) {
  const started = performance.now();
  if (!body || typeof body !== 'object') return { status: 400, body: { error: 'Invalid JSON.' } };
  if (!body.telemetry || typeof body.telemetry !== 'object') return { status: 400, body: { error: 'A telemetry snapshot is required.' } };
  let telemetry;
  try { telemetry = boundTelemetry(body.telemetry); } catch (error) { return { status: 400, body: { error: error.message } }; }
  const connection = body.connection && typeof body.connection === 'object' ? body.connection : {};
  // Only the fields the adapter uses; the JEV endpoint is fixed and cannot be overridden from the page.
  const safe = { provider: connection.provider === 'jev' ? 'jev' : 'laya', token: typeof connection.token === 'string' ? connection.token : '', variant: connection.variant, model: connection.model, timeoutMs: policy.timeoutMs };
  if (safe.provider === 'laya') safe.baseUrl = connection.baseUrl;
  try {
    if (safe.provider === 'laya') await checkEndpoint(safe.baseUrl, policy);
    const result = await decide(telemetry, safe, { briefing: body.briefing });
    return {
      status: 200,
      body: {
        requestId: crypto.randomUUID(), mode: result.mode, provider: result.provider, action: result.choice, telemetry,
        latencyMs: Math.round(performance.now() - started),
        rawProviderOutput: redact(result.rawProviderOutput, safe.token), request: redact(result.request, safe.token), endpoint: result.endpoint
      }
    };
  } catch (error) {
    return { status: 502, body: { error: redact(error.message || 'Lander decision failed.', safe.token) } };
  }
}

// ---- HTTP entry point, shared by server.js and the Vercel function (plain Node req/res only).
const MAX_BODY = 100000;
const header = (req, name) => { const v = req.headers?.[name]; return Array.isArray(v) ? v[0] : v; };
function clientIp(req) { return String(header(req, 'x-forwarded-for') || '').split(',')[0].trim() || header(req, 'x-real-ip') || req.socket?.remoteAddress || 'unknown'; }
// A public relay only serves its own page (and any RELAY_ALLOWED_ORIGINS), so other sites cannot use it.
function originAllowed(req, policy) {
  if (!policy.isPublic) return true;
  let origin = header(req, 'origin');
  if (!origin) { try { origin = new URL(header(req, 'referer')).origin; } catch { return false; } }
  origin = String(origin).toLowerCase().replace(/\/$/, '');
  const host = String(header(req, 'x-forwarded-host') || header(req, 'host') || '').toLowerCase();
  let originHost = '';
  try { originHost = new URL(origin).host; } catch { return false; }
  return (host && originHost === host) || policy.allowedOrigins.includes(origin);
}
const windows = new Map();
function rateLimited(ip, limit, now = Date.now()) {
  if (!limit) return false;
  let w = windows.get(ip);
  if (!w || now - w.start >= 60000) { w = { start: now, count: 0 }; windows.set(ip, w); }
  w.count++;
  if (windows.size > 10000) for (const [key, value] of windows) if (now - value.start >= 60000) windows.delete(key);
  return w.count > limit;
}
async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body; // body already parsed by the platform
  let raw = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? String(req.body) : '';
  if (!raw) for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) throw Object.assign(new Error('Request too large.'), { status: 413 }); }
  if (raw.length > MAX_BODY) throw Object.assign(new Error('Request too large.'), { status: 413 });
  try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function sendJson(res, status, value, extra = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra })) res.setHeader(k, v);
  res.end(JSON.stringify(value));
}
async function serveDecision(req, res, policy = relayPolicy()) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { allow: 'POST' });
    if (!originAllowed(req, policy)) return sendJson(res, 403, { error: 'This relay only serves the Moon Lander page it is deployed with.' });
    if (rateLimited(clientIp(req), policy.rateLimit)) return sendJson(res, 429, { error: 'Too many decisions per minute. Slow down or lower the speed.' }, { 'retry-after': '30' });
    let body;
    try { body = await readJson(req); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    const result = await handleDecision(body, policy);
    return sendJson(res, result.status, result.body);
  } catch {
    return sendJson(res, 500, { error: 'Internal error.' });
  }
}

module.exports = { handleDecision, serveDecision, checkEndpoint, relayPolicy, isPrivateAddress, originAllowed, rateLimited, redact, boundTelemetry };
