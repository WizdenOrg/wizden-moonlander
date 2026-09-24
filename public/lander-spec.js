'use strict';

// Tech-specification data (example inputs in both prompt modes, rules, thresholds), built from the
// live modules. Built in the page, so it needs no server call.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./lander-physics'), require('./lander-guidance'), require('./lander-adapter'));
  else root.LanderSpec = factory(root.LanderPhysics, root.LanderGuidance, root.LanderAdapter);
}(typeof self !== 'undefined' ? self : this, function (physics, guidance, adapter) {
  // Canonical flight situations shown as decision-input examples in the tech specification.
  const SPEC_EXAMPLES = [
    { id: 'far', title: 'Pad far to the right', ship: { x: 1000, y: 260, vx: 0, vy: 1 } },
    { id: 'away', title: 'Drifting away from the pad', ship: { x: 1650, y: 330, vx: 3, vy: 4 } },
    { id: 'overshoot', title: 'About to overshoot', ship: { x: 1370, y: 420, vx: 10, vy: 6 } },
    { id: 'onplan', title: 'On plan, cruising', ship: { x: 1200, y: 380, vx: 12, vy: 5 } },
    { id: 'brake', title: 'Falling too fast near the ground', ship: { x: 1400, y: 950, vx: 0, vy: 14 } },
    { id: 'final', title: 'Final descent over the pad', ship: { x: 1405, y: 985, vx: .4, vy: 2.2 } }
  ];

  // Tech specification data, generated from the live modules so the page never drifts from the code.
  function spec() {
    const terrain = physics.makeTerrain(), example = physics.telemetry(terrain, physics.createShip());
    return {
      variant: adapter.DEFAULT_VARIANT, thresholds: adapter.THRESHOLDS, guidance: guidance.constants, maxBriefingLength: adapter.MAX_BRIEFING_LENGTH,
      example: { telemetry: example, request: adapter.buildRequest(example, adapter.DEFAULT_VARIANT) },
      examples: SPEC_EXAMPLES.map(({ id, title, ship }) => {
        const telemetry = physics.telemetry(terrain, physics.createShip(ship)), plan = guidance.assess(telemetry);
        const requestFor = (variant) => { const { model, ...request } = adapter.buildRequest(telemetry, variant); return request; };
        return {
          id, title, request: requestFor(adapter.DEFAULT_VARIANT), requests: { binary: requestFor('binary'), facts: requestFor('facts') }, fullTelemetry: telemetry,
          telemetry: { altitude: +telemetry.altitude.toFixed(1), verticalVelocity: +telemetry.verticalVelocity.toFixed(2), horizontalVelocity: +telemetry.horizontalVelocity.toFixed(2), padOffset: +telemetry.padOffset.toFixed(1), fuel: +telemetry.fuel.toFixed(0) },
          expected: { brake: plan.mustBrake, go_right: plan.lateralNeed === 'push_right', go_left: plan.lateralNeed === 'push_left' },
          control: plan.recommended
        };
      }),
      providers: [
        { id: 'laya', label: 'Laya', endpoint: '<Laya endpoint>/v1/decisions', auth: 'X-API-Key: <token>', model: 'server default (english)' },
        { id: 'jev', label: 'JEV', endpoint: adapter.JEV_URL, auth: 'Authorization: Bearer <key>', model: 'jev-latest' }
      ]
    };
  }

  return { spec, SPEC_EXAMPLES };
}));
