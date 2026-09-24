'use strict';

const physics = require('../public/lander-physics');
const { CONTROLS } = physics;
const { assess, verticalSentence, lateralSentence } = require('./lander-guidance');

const controls = CONTROLS;
const DEFAULT_VARIANT = 'binary';
const BRAKE_THRESHOLD = .5, SIDEWAYS_THRESHOLD = .5;
const THRESHOLDS = { brake: BRAKE_THRESHOLD, sideways: SIDEWAYS_THRESHOLD };

const CRITERIA = {
  left_thrust: 'Tilt LEFT and burn. Pushes the craft sideways to the LEFT. Choose when the craft needs to accelerate to the left: the pad is to the left, or a rightward drift must be slowed.',
  right_thrust: 'Tilt RIGHT and burn. Pushes the craft sideways to the RIGHT. Choose when the craft needs to accelerate to the right: the pad is to the right, or a leftward drift must be slowed.',
  thrust: 'Upright braking burn. Slows the descent. Choose when the craft is descending too fast and must brake.',
  coast: 'Engine off, stay upright. Choose when the descent is under control and no sideways correction is needed.'
};

// Each variant turns telemetry into a Laya request and turns the answers back into one control.
const VARIANTS = {
  // Original approach: raw numbers and one 4-way choice. Kept as the regression baseline
  // (it lands 0/12: Laya cannot do kinematics on raw telemetry).
  numeric: {
    build(t) {
      const ray = t.landingRay || {};
      return {
        state: { telemetry: t, physics: { gravity_m_s2: 1.62, engine_acceleration_m_s2: 4.8 }, landing_ray: ray, instruction: 'Pilot a lunar lander to a soft landing on the pad. padOffset is craft x minus pad x (negative means the pad is to the right). Positive verticalVelocity is downward. Brake with thrust before touchdown and use directional thrust to move over the pad.' },
        questions: { flight_control: { type: 'choice', instructions: 'Choose exactly one control for the next 0.48 seconds.', criteria: CRITERIA } }
      };
    },
    parse(answers) { return answers?.flight_control?.choice; }
  }
};

// Default. Three yes/no questions in one forward pass. Laya's noul head is its most reliable
// output, so each direction gets its own question instead of competing inside one choice
// (a single 4-way choice over the same text scored 13-57% on the probe set; this scores 100%).
VARIANTS.binary = {
  build(t) {
    const a = assess(t);
    return {
      state: { vertical_situation: verticalSentence(a), sideways_situation: lateralSentence(a) },
      questions: {
        brake: { type: 'noul', instructions: 'Based on the vertical situation, must the engine brake right now to slow the descent?' },
        go_right: { type: 'noul', instructions: 'Based on the sideways situation, does the craft need to accelerate to the RIGHT?' },
        go_left: { type: 'noul', instructions: 'Based on the sideways situation, does the craft need to accelerate to the LEFT?' }
      }
    };
  },
  parse(answers) {
    const score = (key) => noulScore(answers?.[key]);
    const brake = score('brake'), right = score('go_right'), left = score('go_left');
    if (![brake, right, left].every((v) => typeof v === 'number')) return undefined;
    if (brake >= BRAKE_THRESHOLD) return 'thrust';
    if (Math.max(right, left) < SIDEWAYS_THRESHOLD) return 'coast';
    return right >= left ? 'right_thrust' : 'left_thrust';
  }
};

// Facts only: the same three questions, but the state holds measurements and physics facts
// with no conclusions (no stopping-distance verdicts, targets, "required" or "must brake").
// Measures what the model decides on its own, against the guided `binary` prompt.
VARIANTS.facts = {
  build(t) {
    const { vertical, sideways } = factSentences(t);
    return {
      state: { vertical_facts: vertical, sideways_facts: sideways },
      questions: {
        brake: { type: 'noul', instructions: 'Based on these facts, must the engine brake right now so the craft does not reach the ground faster than the safe touchdown speed?' },
        go_right: { type: 'noul', instructions: 'Based on these facts, should the craft accelerate to the RIGHT now, so it reaches the pad and arrives over it with low sideways speed?' },
        go_left: { type: 'noul', instructions: 'Based on these facts, should the craft accelerate to the LEFT now, so it reaches the pad and arrives over it with low sideways speed?' }
      }
    };
  },
  parse(answers) { return VARIANTS.binary.parse(answers); }
};
function factSentences(t) {
  const g = physics.LUNAR_GRAVITY, alt = Math.max(0, t.altitude), vy = t.verticalVelocity, vx = t.horizontalVelocity, off = t.padOffset;
  const netBrake = physics.ENGINE_ACCELERATION - g, sidewaysAccel = physics.DIRECTIONAL_ACCELERATION * Math.sin(physics.MANEUVER_TILT);
  const timeToGround = (-vy + Math.sqrt(Math.max(0, vy * vy + 2 * g * alt))) / g;
  const n = (v, d = 1) => Math.abs(v).toFixed(d);
  const padSide = off < 0 ? 'RIGHT' : 'LEFT', distance = Math.abs(off), moving = Math.abs(vx) < .05 ? null : vx > 0 ? 'RIGHT' : 'LEFT';
  const vertical = [
    `Altitude above the ground: ${n(alt, 0)} m.`,
    vy >= 0 ? `Vertical speed: falling at ${n(vy)} m/s.` : `Vertical speed: rising at ${n(vy)} m/s.`,
    `Gravity adds ${g} m/s of downward speed every second. A braking burn removes about ${netBrake.toFixed(1)} m/s of downward speed per second.`,
    `With no burn, the craft reaches the ground in about ${timeToGround.toFixed(0)} s.`,
    `Safe touchdown requires a downward speed below ${physics.SAFE_VY} m/s. Fuel remaining: ${n(t.fuel, 0)}%.`
  ].join(' ');
  const where = distance < 5 ? 'The landing pad is directly below the craft.' : `The landing pad is ${n(distance, 0)} m to the ${padSide} of the craft.`;
  const motion = !moving ? 'Sideways speed: none.' : `Sideways speed: ${n(vx)} m/s to the ${moving}${distance >= 5 ? (moving === padSide ? ', toward the pad' : ', away from the pad') : ''}.`;
  const eta = moving && moving === padSide && distance >= 5 ? ` At this sideways speed the craft is over the pad in about ${(distance / Math.abs(vx)).toFixed(0)} s.` : '';
  const sideways = `${where} The pad is ${physics.PAD_HALF_WIDTH * 2} m wide. ${motion}${eta} A sideways burn changes sideways speed by about ${sidewaysAccel.toFixed(1)} m/s per second. Safe touchdown requires a sideways speed below ${physics.SAFE_VX} m/s.`;
  return { vertical, sideways };
}

// Same questions as `binary`, but each is sent as its own request (in parallel) carrying only
// the sentence it depends on, so direction words cannot bleed into the braking answer.
VARIANTS.split = {
  build(t) {
    const a = assess(t);
    const vertical = { vertical_situation: verticalSentence(a) }, sideways = { sideways_situation: lateralSentence(a) };
    return [
      { state: vertical, questions: { brake: { type: 'noul', instructions: 'Is the craft descending too fast, so the engine must brake right now?' } } },
      { state: sideways, questions: { go_right: { type: 'noul', instructions: 'Does the craft need to accelerate to the RIGHT?' }, go_left: { type: 'noul', instructions: 'Does the craft need to accelerate to the LEFT?' } } }
    ];
  },
  parse(answers) { return VARIANTS.binary.parse(answers); }
};

// Yes/no score in [0, 1]. Laya returns { noul: 0.83 }; other typed-decision providers may use
// score/probability/value or a boolean/yes-no answer, so accept those too.
function noulScore(answer) {
  if (typeof answer === 'number') return answer;
  if (typeof answer === 'boolean') return answer ? 1 : 0;
  if (!answer || typeof answer !== 'object') return undefined;
  for (const key of ['noul', 'score', 'probability', 'value', 'yes']) if (typeof answer[key] === 'number') return answer[key];
  for (const key of ['answer', 'value', 'result', 'choice']) {
    const v = answer[key];
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string' && /^(yes|true)$/i.test(v)) return 1;
    if (typeof v === 'string' && /^(no|false)$/i.test(v)) return 0;
  }
  return undefined;
}
const answersOf = (r) => r?.answers || r?.result?.answers || r?.output?.answers || r?.data?.answers || {};

const MAX_BRIEFING_LENGTH = 500;
// Operator briefing for a campaign: trimmed, single-spaced, control characters removed.
function cleanBriefing(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_BRIEFING_LENGTH) : '';
}
// Adds the briefing to the state and asks every question to weigh it. Without a briefing the
// request is left exactly as the variant built it.
function withBriefing(body, briefing) {
  if (!briefing) return body;
  const questions = Object.fromEntries(Object.entries(body.questions).map(([key, q]) => [key, { ...q, instructions: `${q.instructions} Take the mission briefing into account.` }]));
  return { ...body, state: { ...body.state, mission_briefing: briefing }, questions };
}

// Returns every request body needed for one decision (variants may split questions).
// The same bodies go to every provider; only transport (endpoint, auth, model name) differs.
function buildRequests(telemetry, variant = DEFAULT_VARIANT, model, options = {}) {
  const spec = VARIANTS[variant];
  if (!spec) throw new Error(`Unknown lander prompt variant ${variant}.`);
  const built = spec.build(telemetry), briefing = cleanBriefing(options.briefing);
  return (Array.isArray(built) ? built : [built]).map((body) => ({ ...withBriefing(body, briefing), model: model || undefined }));
}
function buildRequest(telemetry, variant = DEFAULT_VARIANT, model, options) { return buildRequests(telemetry, variant, model, options)[0]; }

// Accepts one Laya response or an array of them (one per request from buildRequests).
function choiceFrom(response, variant = DEFAULT_VARIANT) {
  const responses = Array.isArray(response) ? response : [response];
  const answers = Object.assign({}, ...responses.map(answersOf));
  const choice = VARIANTS[variant].parse(answers);
  if (!controls.includes(choice)) throw new Error('The model returned a control outside the current flight safety envelope.');
  return choice;
}

// Decision providers. Both receive the same typed questions; they differ in endpoint and auth.
const PROVIDERS = {
  laya: {
    label: 'Laya',
    url(connection) {
      const configuredUrl = String(connection.baseUrl || '').replace(/\/$/, '');
      if (!/^https?:\/\//.test(configuredUrl)) throw new Error('A valid Laya endpoint is required in LIVE mode.');
      // Accept either the Colab public base URL or a pasted full decisions URL.
      return configuredUrl.endsWith('/v1/decisions') ? configuredUrl : `${configuredUrl}/v1/decisions`;
    },
    headers: (token) => ({ 'x-api-key': token }),
    body: (request, connection) => ({ ...request, model: connection.model || undefined }),
    unreachable: 'Restart the Colab tunnel and update the saved endpoint.'
  },
  jev: {
    label: 'JEV',
    // baseUrl is only set by tests (fake endpoint); the UI always uses the public API.
    url: (connection) => connection.baseUrl || JEV_URL,
    headers: (token) => ({ authorization: `Bearer ${token}` }),
    body: (request, connection) => ({ model: connection.model || 'jev-latest', state: request.state, questions: request.questions }),
    unreachable: 'Check the network connection to api.typesafe.ai.'
  }
};
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

async function decide(telemetry, connection = {}, options = {}) {
  const providerName = PROVIDERS[connection.provider] ? connection.provider : 'laya';
  const provider = PROVIDERS[providerName];
  const url = provider.url(connection);
  if (!connection.token) throw new Error(`A ${provider.label} API key is required.`);
  const variant = VARIANTS[connection.variant] ? connection.variant : DEFAULT_VARIANT;
  const bodies = buildRequests(telemetry, variant, undefined, options).map((request) => provider.body(request, connection));
  const outputs = await Promise.all(bodies.map((body) => post(provider, url, connection.token, body)));
  const rawProviderOutput = outputs.length === 1 ? outputs[0] : outputs;
  // `request` is exactly what was sent (without auth headers), for the page's tech view.
  return { mode: 'LIVE', provider: providerName, variant, choice: choiceFrom(outputs, variant), rawProviderOutput, request: bodies.length === 1 ? bodies[0] : bodies, endpoint: url };
}

async function post(provider, url, token, body) {
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...provider.headers(token) }, signal: AbortSignal.timeout(30000), body: JSON.stringify(body) });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
    throw new Error(`${provider.label} endpoint ${reason}. ${provider.unreachable}`);
  }
  if (!response.ok) {
    const text = await response.text();
    // Tunnels and gateways answer with HTML error pages; report them plainly.
    if (/^\s*</.test(text) || [502, 503, 504, 530].includes(response.status)) throw new Error(`${provider.label} endpoint is offline (HTTP ${response.status}). ${provider.unreachable}`);
    const detail = text.replace(/\s+/g, ' ').slice(0, 180);
    throw new Error(`${provider.label} endpoint rejected the request (${response.status}): ${detail || response.statusText}`);
  }
  return response.json();
}

const PROMPT_MODES = { binary: 'Guided', facts: 'Facts only' };
module.exports = { decide, PROMPT_MODES, factSentences, THRESHOLDS, cleanBriefing, MAX_BRIEFING_LENGTH, noulScore, PROVIDERS, JEV_URL, buildRequest, buildRequests, choiceFrom, controls, VARIANTS, DEFAULT_VARIANT, CRITERIA };
