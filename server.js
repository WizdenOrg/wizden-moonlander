'use strict';

// Local server: serves the game and the decision relay (the same relay the Vercel functions use).
// It listens on localhost by default, because the relay forwards requests to the endpoint the page
// supplies. See README "Deploy to Vercel" for the hosted setup.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { serveDecision } = require('./src/relay');
const { SECURITY_HEADERS } = require('./src/http-headers');

const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 3030);
const host = process.env.HOST || '127.0.0.1';
const CONTENT_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function send(res, status, type, content) { res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': `${type}; charset=utf-8` }); res.end(content); }
function json(res, status, value) { res.setHeader('cache-control', 'no-store'); send(res, status, 'application/json', JSON.stringify(value)); }
function serveStatic(pathname, res) {
  let requested;
  try { requested = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { return json(res, 400, { error: 'Bad path' }); }
  const file = path.resolve(publicDir, `.${requested}`);
  if (!file.startsWith(publicDir + path.sep)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (error, content) => {
    if (error) return json(res, 404, { error: 'Not found' });
    send(res, 200, CONTENT_TYPES[path.extname(file)] || 'application/octet-stream', content);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname.replace(/(.)\/$/, '$1');
  if (pathname === '/api/lander/decide') { for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v); return serveDecision(req, res); }
  if (req.method === 'GET') return serveStatic(pathname, res);
  return json(res, 405, { error: 'Method not allowed' });
});

if (require.main === module) server.listen(port, host, () => console.log(`Wizden Moon Lander listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
module.exports = { server };
