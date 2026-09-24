'use strict';

// Vercel function: POST /api/lander/decide. The same relay the local server uses.
const { serveDecision } = require('../../src/relay');

module.exports = (req, res) => serveDecision(req, res);
