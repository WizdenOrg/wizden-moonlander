'use strict';

// Deployment-facing relay behaviour: endpoint guard, Vercel function contract, security headers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkEndpoint, relayPolicy, isPrivateAddress, handleDecision, serveDecision, originAllowed, rateLimited } = require('../src/relay');
const physics = require('../public/lander-physics');
const decideFn = require('../api/lander/decide');
const { server } = require('../server');

const telemetry = physics.telemetry(physics.makeTerrain(), physics.createShip({ x: 900 }));
const publicPolicy = { isPublic: true, allowedHosts: [] };

test('policy is public on Vercel or when RELAY_PUBLIC=1, and local otherwise', () => {
  assert.equal(relayPolicy({}).isPublic, false);
  assert.equal(relayPolicy({ VERCEL: '1' }).isPublic, true);
  assert.equal(relayPolicy({ RELAY_PUBLIC: '1' }).isPublic, true);
  assert.deepEqual(relayPolicy({ LAYA_ALLOWED_HOSTS: '*.trycloudflare.com, laya.example.com' }).allowedHosts, ['*.trycloudflare.com', 'laya.example.com']);
});

test('private, loopback and link-local addresses are recognised', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(a), a);
});

test('public deployments only relay to public https Laya endpoints', async () => {
  await assert.rejects(checkEndpoint('http://example.com', publicPolicy), /https/);
  await assert.rejects(checkEndpoint('https://localhost:8080', publicPolicy), /public address/);
  await assert.rejects(checkEndpoint('https://127.0.0.1', publicPolicy), /public address/);
  await assert.rejects(checkEndpoint('https://169.254.169.254/latest', publicPolicy), /public address/);
  await assert.rejects(checkEndpoint('https://[::1]/', publicPolicy), /public address/);
  await assert.rejects(checkEndpoint('https://metadata.google.internal', publicPolicy), /public address/);
  await assert.rejects(checkEndpoint('not a url', publicPolicy), /valid Laya endpoint/);
  await assert.doesNotReject(checkEndpoint('https://8.8.8.8', publicPolicy));
  await assert.rejects(checkEndpoint('https://8.8.8.8', { isPublic: true, allowedHosts: ['*.trycloudflare.com'] }), /not allowed/);
  await assert.doesNotReject(checkEndpoint('http://127.0.0.1:8080', { isPublic: false, allowedHosts: [] }), 'local use may call a Laya server on this machine');
});

test('a public relay refuses to forward to a private Laya endpoint', async () => {
  const result = await handleDecision({ telemetry, connection: { provider: 'laya', baseUrl: 'https://127.0.0.1:9', token: 'secret-token' } }, publicPolicy);
  assert.equal(result.status, 502);
  assert.match(result.body.error, /public address/);
});

test('the relay never lets the page redirect the JEV endpoint', async () => {
  // A baseUrl on a JEV connection is dropped, so the key can only go to Typesafe. With no key the
  // request fails before any network call, which is enough to see the endpoint that would be used.
  const result = await handleDecision({ telemetry, connection: { provider: 'jev', baseUrl: 'https://attacker.example', token: '' } }, publicPolicy);
  assert.equal(result.status, 502);
  assert.match(result.body.error, /JEV API key is required/);
});

// Plain Node-style request/response objects, as the Vercel Node runtime provides.
function fakeReq({ method = 'POST', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)];
  return { method, headers, socket: { remoteAddress: '203.0.113.9' }, async *[Symbol.asyncIterator]() { yield* chunks; } };
}
function fakeRes() {
  const res = { statusCode: 200, headers: {}, payload: undefined };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (text) => { res.payload = text ? JSON.parse(text) : undefined; };
  return res;
}
const site = { origin: 'https://lander.example.com', host: 'lander.example.com' };
const publicRelay = { ...publicPolicy, allowedOrigins: [], rateLimit: 0, timeoutMs: 25000 };

test('Vercel decide function: method, JSON and telemetry validation', async () => {
  let res = fakeRes();
  await decideFn(fakeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  res = fakeRes();
  await decideFn(fakeReq({ body: 'not json' }), res);
  assert.equal(res.statusCode, 400);
  res = fakeRes();
  await decideFn(fakeReq({ body: { telemetry: {} } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /Telemetry altitude/);
  res = fakeRes();
  await decideFn(fakeReq({ body: 'x'.repeat(100001) }), res);
  assert.equal(res.statusCode, 413);
  res = fakeRes();
  await decideFn(fakeReq({ body: { telemetry, connection: { provider: 'jev', token: '' } } }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('a pre-parsed body (platform body parsing) is accepted', async () => {
  const req = { ...fakeReq(), body: { telemetry, connection: { provider: 'jev', token: '' } } };
  const res = fakeRes();
  await serveDecision(req, res, { ...publicRelay, isPublic: false });
  assert.equal(res.statusCode, 502);
  assert.match(res.payload.error, /JEV API key/);
});

test('a public relay only serves its own page or listed origins', async () => {
  assert.ok(originAllowed({ headers: site }, publicRelay));
  assert.ok(originAllowed({ headers: { host: site.host, referer: 'https://lander.example.com/index.html' } }, publicRelay));
  assert.ok(!originAllowed({ headers: { host: site.host, origin: 'https://evil.example' } }, publicRelay));
  assert.ok(!originAllowed({ headers: { host: site.host } }, publicRelay), 'no origin at all is refused on a public relay');
  assert.ok(originAllowed({ headers: { host: site.host, origin: 'https://preview.example' } }, { ...publicRelay, allowedOrigins: ['https://preview.example'] }));
  assert.ok(originAllowed({ headers: {} }, { ...publicRelay, isPublic: false }), 'local use has no origin check');
  const res = fakeRes();
  await serveDecision(fakeReq({ headers: { host: site.host, origin: 'https://evil.example' }, body: { telemetry } }), res, publicRelay);
  assert.equal(res.statusCode, 403);
});

test('rate limit: per client per minute, then a 429', async () => {
  const ip = `198.51.100.${Math.floor(Math.random() * 200)}`;
  for (let i = 0; i < 3; i++) assert.equal(rateLimited(ip, 3, 1000), false);
  assert.equal(rateLimited(ip, 3, 1000), true);
  assert.equal(rateLimited(ip, 3, 61001), false, 'a new minute resets the window');
  const policy = { ...publicRelay, rateLimit: 1 }, headers = { ...site, 'x-forwarded-for': '192.0.2.77' };
  let res = fakeRes();
  await serveDecision(fakeReq({ headers, body: { telemetry: {} } }), res, policy);
  assert.equal(res.statusCode, 400);
  res = fakeRes();
  await serveDecision(fakeReq({ headers, body: { telemetry: {} } }), res, policy);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '30');
});

test('model timeout stays under the function limit', () => {
  const config = require('../vercel.json');
  assert.ok(relayPolicy({}).timeoutMs < config.functions['api/**/*.js'].maxDuration * 1000);
  assert.equal(relayPolicy({ PROVIDER_TIMEOUT_MS: '5000' }).timeoutMs, 5000);
});

test('vercel.json serves public/, bounds function time, and mirrors the security headers', () => {
  const config = require('../vercel.json');
  const { SECURITY_HEADERS } = require('../src/http-headers');
  assert.equal(config.outputDirectory, 'public');
  assert.ok(config.functions['api/**/*.js'].maxDuration <= 60);
  const headers = Object.fromEntries(config.headers[0].headers.map((h) => [h.key, h.value]));
  assert.deepEqual(headers, SECURITY_HEADERS);
});

test('local server sends the security headers', async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  } finally { await new Promise((r) => server.close(r)); }
});
