'use strict';

// Flight-situation analysis shared by the Laya prompt, the reference controller and the tests.
// Laya is a small typed-decision classifier: it maps well-described situations to choices,
// but it cannot do kinematics on raw numbers. This module turns raw telemetry into
// the physical assessments a pilot would make, so the model decides on meaning, not arithmetic.
// Shared by the browser (tech spec) and the Node relay, tests and evaluation.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LanderGuidance = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const BRAKE_DECELERATION = 2.6; // conservative net braking (engine 4.8 - gravity 1.62, with margin)
  const DECISION_LAG_S = 2.4; // simulated seconds between a snapshot and the next chance to react
  const GRAVITY = 1.62;
  const MAX_DESCENT = 22; // m/s: never let the fall exceed what one brake cycle can recover
  const LATERAL_BRAKE = 1.0; // m/s^2 usable for lateral stopping
  const MAX_LATERAL = 12;
  const FAR_FROM_PAD = 90; // m: beyond this the craft should not fall fast while it translates
  const FAR_DESCENT = 6;
  const LOW_ALTITUDE = 120;
  const FINAL_DESCENT_ALTITUDE = 30;

  function assess(t) {
    const alt = t.altitude, vy = t.verticalVelocity, vx = t.horizontalVelocity, off = t.padOffset;
    // Distance covered while the next decision is pending (gravity keeps accelerating the fall),
    // plus the braking distance from the speed reached by then.
    const lagDrop = Math.max(0, vy * DECISION_LAG_S + .5 * GRAVITY * DECISION_LAG_S ** 2);
    const lagSpeed = Math.max(0, vy + GRAVITY * DECISION_LAG_S);
    const stoppingDistance = lagDrop + lagSpeed * lagSpeed / (2 * BRAKE_DECELERATION);
    const tooFastForAltitude = stoppingDistance > alt - 5;
    const overSpeed = vy > MAX_DESCENT;
    // Far from the pad: brake only if, at the current descent rate, the craft would reach the
    // low-altitude zone before its sideways motion gets it over the pad.
    const approachSpeed = Math.max(2, off < 0 ? vx : -vx);
    const timeToPad = Math.abs(off) / approachSpeed;
    const timeToLowAltitude = Math.max(0, alt - LOW_ALTITUDE) / Math.max(vy, .5);
    const farAndFalling = Math.abs(off) > FAR_FROM_PAD && vy > FAR_DESCENT && timeToPad > timeToLowAltitude;
    const mustBrake = tooFastForAltitude || overSpeed || farAndFalling;
    const brakeReason = tooFastForAltitude ? 'stopping_distance' : overSpeed ? 'overspeed' : farAndFalling ? 'far_from_pad' : null;

    const distance = Math.abs(off);
    const padSide = off < 0 ? 'right' : 'left';
    const targetSpeed = Math.min(distance / 8, Math.sqrt(2 * LATERAL_BRAKE * distance), MAX_LATERAL);
    const targetVx = off < 0 ? targetSpeed : -targetSpeed;
    const lateralError = targetVx - vx;
    const tolerance = alt < 80 ? 1.0 : 1.5;
    // Translation burns tilt the craft; near the ground it must stay upright for touchdown.
    const finalDescent = alt < FINAL_DESCENT_ALTITUDE;
    const lateralNeed = finalDescent ? 'hold' : lateralError > tolerance ? 'push_right' : lateralError < -tolerance ? 'push_left' : 'hold';
    const movingSide = Math.abs(vx) < .3 ? 'none' : vx > 0 ? 'right' : 'left';
    const towardPad = movingSide === padSide;

    let lateralReason;
    if (finalDescent) lateralReason = 'final_descent';
    else if (lateralNeed === 'hold') lateralReason = 'on_plan';
    else if ((lateralNeed === 'push_right' && padSide === 'right') || (lateralNeed === 'push_left' && padSide === 'left')) lateralReason = towardPad ? 'too_slow_toward_pad' : movingSide === 'none' ? 'not_moving_toward_pad' : 'drifting_away';
    else lateralReason = towardPad ? 'overshoot_risk' : 'drifting_away';

    // The single control the reference plan would choose; used to label test probes.
    const recommended = mustBrake ? 'thrust' : lateralNeed === 'push_right' ? 'right_thrust' : lateralNeed === 'push_left' ? 'left_thrust' : 'coast';
    return { alt, vy, vx, off, distance, padSide, movingSide, towardPad, stoppingDistance, mustBrake, brakeReason, targetVx, lateralError, lateralNeed, lateralReason, recommended };
  }

  const round = (v) => Math.round(Math.abs(v));

  function verticalSentence(a) {
    if (a.brakeReason === 'stopping_distance') return `DANGER: descending too fast. Falling at ${round(a.vy)} m/s needs about ${round(a.stoppingDistance)} m to stop, but only ${round(a.alt)} m of altitude remain. The engine must brake now.`;
    if (a.brakeReason === 'overspeed') return `DANGER: descending too fast. Descent speed ${round(a.vy)} m/s is above the ${MAX_DESCENT} m/s safety limit. The engine must brake now.`;
    if (a.brakeReason === 'far_from_pad') return `DANGER: descending too fast. Falling at ${round(a.vy)} m/s while the pad is still ${round(a.distance)} m away, the craft will hit the ground before reaching it. The engine must brake now.`;
    if (a.vy < 1) return `The craft is hovering or climbing, so it is not descending too fast. Braking is not needed.`;
    return `Descent speed is safe. Falling at ${round(a.vy)} m/s needs about ${round(a.stoppingDistance)} m to stop and ${round(a.alt)} m of altitude remain. Braking is not needed yet.`;
  }

  function lateralSentence(a) {
    const dir = a.lateralNeed === 'push_right' ? 'RIGHT' : 'LEFT';
    const need = `Required sideways correction: accelerate to the ${dir}.`;
    const where = a.distance < 20 ? 'The craft is directly above the pad' : `The pad is ${round(a.distance)} m to the ${a.padSide}`;
    const speed = Math.abs(a.vx).toFixed(1);
    switch (a.lateralReason) {
      case 'final_descent': return 'The craft is in its final descent close to the ground and must stay upright for touchdown. No sideways correction is needed.';
      case 'on_plan': return a.distance < 20 ? 'The craft is directly above the pad and nearly still sideways. No sideways correction is needed.' : `The craft's sideways speed is already carrying it to the pad at the planned rate. No sideways correction is needed.`;
      case 'too_slow_toward_pad': return `${where}. The craft moves toward it at only ${speed} m/s, too slowly to arrive in time. ${need}`;
      case 'not_moving_toward_pad': return `${where} and the craft is not moving toward it. ${need}`;
      case 'drifting_away': return `${where}, but the craft drifts the wrong way, away from it, at ${speed} m/s. ${need}`;
      case 'overshoot_risk': return a.distance < 20 ? `The craft is above the pad but still sliding sideways at ${speed} m/s and will slide past it. ${need}` : `${where}. The craft approaches it at ${speed} m/s, too fast, and will overshoot. ${need}`;
      default: return where;
    }
  }

    return { assess, verticalSentence, lateralSentence, constants: { BRAKE_DECELERATION, DECISION_LAG_S, MAX_DESCENT, GRAVITY, LATERAL_BRAKE, MAX_LATERAL, FINAL_DESCENT_ALTITUDE, FAR_FROM_PAD, FAR_DESCENT, LOW_ALTITUDE } };
}));
