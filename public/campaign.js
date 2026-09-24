'use strict';

// Campaign board: per-pilot score rings, aggregate stats, action mix, one card per mission
// (flight paths of every pilot over that mission's terrain) and past campaigns.
// Pure rendering; app.js owns the flight loop and the campaign state.
(function (root) {
  const ACTIONS = ['left_thrust', 'right_thrust', 'thrust', 'coast'];
  const ACTION_LABELS = { left_thrust: 'LEFT BURN', right_thrust: 'RIGHT BURN', thrust: 'BRAKE', coast: 'COAST' };
  const PILOTS = { laya: { label: 'LAYA', short: 'L', color: '#fa935b' }, jev: { label: 'JEV', short: 'J', color: '#60a5fa' } };
  const SVG_W = 220, SVG_H = 112;
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const fixed = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : NaN);
  const callsOf = (counts) => ACTIONS.reduce((n, a) => n + (counts?.[a] || 0), 0);
  const lateralShare = (counts) => { const n = callsOf(counts); return n ? Math.round(((counts.left_thrust || 0) + (counts.right_thrust || 0)) / n * 100) : 0; };
  // reason: landed | off_pad (soft touchdown outside the pad) | impact; 'outside_pad' is a legacy crash off the pad.
  const resultLabel = (r) => (r.status === 'active' ? 'IN FLIGHT' : r.landed ? 'LANDED' : r.reason === 'off_pad' ? 'OFF PAD' : r.reason === 'outside_pad' ? 'MISSED PAD' : 'CRASHED');
  const resultState = (r) => (r.status === 'active' ? 'active' : r.landed ? 'landed' : r.reason === 'off_pad' ? 'offpad' : 'crashed');

  // The exact terrain the mission flew over (same points the main screen draws), cached per pad.
  const terrainCache = new Map();
  function missionTerrain(P, padCenter) {
    if (!terrainCache.has(padCenter)) { if (terrainCache.size > 24) terrainCache.clear(); terrainCache.set(padCenter, P.makeTerrain(padCenter)); }
    return terrainCache.get(padCenter);
  }

  // Mission map: every pilot's flight path, framed around the paths and the pad.
  function trajectorySvg(mission, pilots, P) {
    const paths = pilots.map((p) => ({ pilot: p, result: mission.pilots[p], path: mission.pilots[p]?.path || [] })).filter((x) => x.path.length);
    if (!paths.length) return `<svg class="traj" viewBox="0 0 ${SVG_W} ${SVG_H}" aria-hidden="true"></svg>`;
    const padCenter = mission.padCenter, terrain = missionTerrain(P, padCenter), padY = terrain.padY;
    const all = paths.flatMap((x) => x.path);
    let minX = Math.min(...all.map((p) => p[0]), padCenter - P.PAD_HALF_WIDTH) - 70, maxX = Math.max(...all.map((p) => p[0]), padCenter + P.PAD_HALF_WIDTH) + 70;
    const minY = Math.min(...all.map((p) => p[1])) - 40;
    let maxY = padY + 40;
    for (const point of terrain) if (point.x >= minX && point.x <= maxX) maxY = Math.max(maxY, point.y + 30);
    // Keep the card's aspect ratio by widening whichever axis is short.
    const aspect = SVG_W / SVG_H, spanX = maxX - minX, spanY = maxY - minY;
    let viewMinY = minY, viewSpanY = spanY;
    if (spanX / spanY < aspect) { const extra = spanY * aspect - spanX; minX -= extra / 2; maxX += extra / 2; } else { viewSpanY = spanX / aspect; viewMinY = maxY - viewSpanY; }
    const sx = (x) => ((x - minX) / (maxX - minX)) * SVG_W, sy = (y) => ((y - viewMinY) / viewSpanY) * SVG_H;
    const pt = (p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`;
    const groundY = (x) => P.groundAt(terrain, x).y;
    const ground = [[minX, groundY(minX)], ...terrain.filter((p) => p.x > minX && p.x < maxX).map((p) => [p.x, p.y]), [maxX, groundY(maxX)]].map(pt);
    const flights = paths.map(({ pilot, result, path }) => {
      const end = path[path.length - 1], state = resultState(result), color = PILOTS[pilot].color;
      const mark = state === 'active'
        ? `<circle class="traj-ship" cx="${sx(end[0]).toFixed(1)}" cy="${sy(end[1]).toFixed(1)}" r="3.4" style="fill:${color}"/>`
        : state === 'landed'
          ? `<circle class="traj-end" cx="${sx(end[0]).toFixed(1)}" cy="${sy(end[1]).toFixed(1)}" r="3.4"/>`
          : state === 'offpad'
            ? `<circle class="traj-offpad" cx="${sx(end[0]).toFixed(1)}" cy="${sy(end[1]).toFixed(1)}" r="3.2"/>`
          : `<g class="traj-crash" transform="translate(${sx(end[0]).toFixed(1)} ${sy(end[1]).toFixed(1)})"><path d="M-3.5-3.5L3.5 3.5M3.5-3.5L-3.5 3.5"/></g>`;
      return `<polyline class="traj-path${state === 'active' ? ' is-live' : ''}" style="stroke:${color}" points="${path.map(pt).join(' ')}"/>${mark}`;
    }).join('');
    const start = paths[0].path[0], gid = `soil-${esc(mission.startedAt)}`;
    return `<svg class="traj" viewBox="0 0 ${SVG_W} ${SVG_H}" role="img" aria-label="Flight paths over the mission terrain">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9ca3af"/><stop offset="1" stop-color="#232833"/></linearGradient></defs>
      <polygon class="traj-ground" fill="url(#${gid})" points="0,${SVG_H} ${ground.join(' ')} ${SVG_W},${SVG_H}"/>
      <line class="traj-pad" x1="${sx(padCenter - P.PAD_HALF_WIDTH).toFixed(1)}" x2="${sx(padCenter + P.PAD_HALF_WIDTH).toFixed(1)}" y1="${(sy(padY) - 1).toFixed(1)}" y2="${(sy(padY) - 1).toFixed(1)}"/>
      ${flights}
      <circle class="traj-start" cx="${sx(start[0]).toFixed(1)}" cy="${sy(start[1]).toFixed(1)}" r="2.6"/>
    </svg>`;
  }

  function mixBar(counts, className = 'mix') {
    if (!callsOf(counts)) return `<div class="${className} is-empty"></div>`;
    return `<div class="${className}">${ACTIONS.map((a) => { const n = counts[a] || 0; return n ? `<i class="act-${a}" style="flex:${n}" title="${ACTION_LABELS[a]} ${n}"></i>` : ''; }).join('')}</div>`;
  }

  function singleStats(r) {
    const active = r.status === 'active';
    return `<dl>
        <div><dt>MISS</dt><dd>${active ? '—' : `${fixed(Math.abs(r.padOffset), 0)}m`}</dd></div>
        <div><dt>V</dt><dd>${active ? '—' : fixed(Math.abs(r.vy), 2)}</dd></div>
        <div><dt>H</dt><dd>${active ? '—' : fixed(Math.abs(r.vx), 2)}</dd></div>
        <div><dt>FUEL</dt><dd>${fixed(Math.max(0, r.fuel), 0)}%</dd></div>
        <div><dt>TIME</dt><dd>${fixed(r.simSeconds, 0)}s</dd></div>
        <div><dt>LATERAL</dt><dd>${lateralShare(r.counts)}%</dd></div>
      </dl>${mixBar(r.counts, 'mix mix-mini')}`;
  }
  function pilotRows(mission, pilots) {
    return `<div class="pilot-rows">${pilots.map((p) => {
      const r = mission.pilots[p]; if (!r) return '';
      const active = r.status === 'active';
      return `<div class="pilot-row is-${resultState(r)}">
        <header><i style="--pilot:${PILOTS[p].color}"></i><b>${PILOTS[p].label}</b><span>${resultLabel(r)}</span></header>
        <p>${active ? `fuel ${fixed(Math.max(0, r.fuel), 0)}% · ${fixed(r.simSeconds, 0)}s` : `miss ${fixed(Math.abs(r.padOffset), 0)}m · V ${fixed(Math.abs(r.vy), 2)} · fuel ${fixed(Math.max(0, r.fuel), 0)}%`}</p>
        ${mixBar(r.counts, 'mix mix-mini')}
      </div>`;
    }).join('')}</div>`;
  }

  function missionCard(mission, index, pilots, P) {
    if (!mission) return `<li class="mission-card is-pending"><header><span>M${pad2(index + 1)}</span><b>STANDBY</b></header><div class="traj-empty">AWAITING LAUNCH</div></li>`;
    const results = pilots.map((p) => mission.pilots[p]).filter(Boolean);
    const active = results.some((r) => r.status === 'active'), landed = results.filter((r) => r.landed).length;
    const offpad = results.filter((r) => r.reason === 'off_pad').length;
    const state = active ? 'is-active' : landed === results.length ? 'is-landed' : offpad === results.length ? 'is-offpad' : landed === 0 && offpad === 0 ? 'is-crashed' : 'is-split';
    const label = active ? 'IN FLIGHT' : pilots.length === 1 ? resultLabel(results[0]) : `${landed}/${results.length} LANDED`;
    const launchSide = mission.launchOffset < 0 ? 'L' : 'R';
    return `<li class="mission-card ${state}">
      <header><span>M${pad2(index + 1)}</span><b>${label}</b></header>
      ${trajectorySvg(mission, pilots, P)}
      <p class="mission-launch">PAD ${Math.round(mission.padCenter)} · LAUNCH ${Math.abs(Math.round(mission.launchOffset))}M ${launchSide}</p>
      ${pilots.length === 1 ? singleStats(results[0]) : pilotRows(mission, pilots)}
    </li>`;
  }

  function render(state, P) {
    const board = document.getElementById('campaign');
    if (!board) return;
    const current = state.current;
    const pilots = current?.pilots || ['laya'];
    const missions = current?.missions || [];
    const total = current?.total || 10;
    const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];
    board.querySelector('#campaign-count').textContent = words[total] || String(total);
    board.querySelector('#campaign-noun').textContent = total === 1 ? 'landing.' : 'landings.';
    board.querySelector('#mission-grid').classList.toggle('is-many', total > 10);
    const briefing = board.querySelector('#campaign-briefing');
    briefing.hidden = !current?.briefing; briefing.innerHTML = current?.briefing ? `<span>BRIEFING</span>${esc(current.briefing)}` : '';
    board.classList.toggle('is-duel', pilots.length > 1);
    const done = missions.filter((m) => m.status !== 'active');
    board.querySelector('#campaign-progress').textContent = `${pad2(done.length)} / ${pad2(total)} FLOWN${pilots.length > 1 ? ' · SIDE BY SIDE' : ` · ${PILOTS[pilots[0]].label}`} · ${current?.prompt === 'facts' ? 'FACTS ONLY' : 'GUIDED'}`;

    const perPilot = pilots.map((p) => {
      const results = done.map((m) => m.pilots[p]).filter(Boolean), landed = results.filter((r) => r.landed), offpad = results.filter((r) => r.reason === 'off_pad');
      const counts = Object.fromEntries(ACTIONS.map((a) => [a, missions.reduce((n, m) => n + (m.pilots[p]?.counts?.[a] || 0), 0)]));
      return { pilot: p, results, landed, offpad, counts, calls: callsOf(counts) };
    });

    board.querySelector('#campaign-rings').innerHTML = perPilot.map(({ pilot, results, landed, offpad }) => `
      <div class="campaign-ring" style="--landed:${landed.length / total};--offpad-share:${offpad.length / total};--crashed:${(results.length - landed.length - offpad.length) / total};--pilot:${PILOTS[pilot].color}" title="${landed.length} landed · ${offpad.length} off pad · ${results.length - landed.length - offpad.length} crashed">
        <div><b>${landed.length}/${total}</b><small>${results.length ? `${Math.round(landed.length / results.length * 100)}% SUCCESS` : 'NO FLIGHTS'}</small>${offpad.length ? `<small class="ring-offpad">${offpad.length} OFF PAD</small>` : ''}</div>
        ${pilots.length > 1 ? `<span class="ring-label">${PILOTS[pilot].label}</span>` : ''}
      </div>`).join('');

    const cells = ({ results, landed, calls, counts }) => [
      landed.length ? `${fixed(mean(landed.map((r) => Math.abs(r.padOffset))), 1)} m` : '—',
      landed.length ? `${fixed(mean(landed.map((r) => Math.abs(r.vy))), 2)} m/s` : '—',
      results.length ? `${fixed(mean(results.map((r) => Math.max(0, r.fuel))), 0)}%` : '—',
      calls ? `${lateralShare(counts)}%` : '—',
      String(calls)
    ];
    const heads = ['AVG MISS', 'TOUCHDOWN V', 'FUEL LEFT', 'LATERAL BURNS', 'MODEL CALLS'];
    board.querySelector('#campaign-stats').innerHTML = pilots.length === 1
      ? heads.map((h, i) => `<div><dt>${h}</dt><dd>${cells(perPilot[0])[i]}</dd></div>`).join('')
      : `<div class="stats-table" role="table"><div role="row" class="stats-head"><span></span>${heads.map((h) => `<span role="columnheader">${h}</span>`).join('')}</div>${perPilot.map((pp) => `<div role="row"><b style="--pilot:${PILOTS[pp.pilot].color}"><i></i>${PILOTS[pp.pilot].label}</b>${cells(pp).map((c) => `<span role="cell">${c}</span>`).join('')}</div>`).join('')}</div>`;

    board.querySelector('#campaign-mix').innerHTML = perPilot.map(({ pilot, counts }) => `
      <div class="mix-row">${pilots.length > 1 ? `<b style="--pilot:${PILOTS[pilot].color}">${PILOTS[pilot].label}</b>` : ''}${mixBar(counts, 'mix mix-wide')}</div>`).join('')
      + `<ul class="mix-legend">${ACTIONS.map((a) => `<li><i class="act-${a}"></i>${ACTION_LABELS[a]}${pilots.length === 1 ? ` <b>${perPilot[0].counts[a]}</b>` : ''}</li>`).join('')}</ul>`;

    board.querySelector('#mission-grid').innerHTML = Array.from({ length: total }, (_, i) => missionCard(missions[i], i, pilots, P)).join('');

    const history = state.history || [];
    board.querySelector('#campaign-history').innerHTML = `<span>PAST CAMPAIGNS</span>` + (history.length
      ? history.slice(0, 8).map((h) => {
        const entries = Object.entries(h.results || {});
        const perfect = entries.every(([, r]) => r.landed === h.total);
        const score = entries.length > 1 ? entries.map(([p, r]) => `${PILOTS[p]?.short || p} ${r.landed}`).join(' · ') + `/${h.total}` : `${entries[0]?.[1].landed ?? 0}/${h.total}`;
        const when = new Date(h.finishedAt);
        return `<b class="${perfect ? 'is-perfect' : ''}${h.briefing ? ' has-briefing' : ''}${h.prompt === 'facts' ? ' is-facts' : ''}" title="${esc(when.toLocaleString())} · ${h.prompt === 'facts' ? 'Facts only' : 'Guided'}${h.briefing ? ` · Briefing: ${esc(h.briefing)}` : ''}">${esc(score)}<small>${esc(when.toLocaleDateString([], { month: 'short', day: 'numeric' }))} ${esc(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</small></b>`;
      }).join('')
      : '<em>Completed campaigns are archived here.</em>');
  }

  // Refresh only the in-flight card, in place: the element is kept and its content is
  // rewritten only when it changed, so frequent updates never flash.
  function renderActive(mission, index, total, P, pilots) {
    const card = document.querySelectorAll('#mission-grid .mission-card')[index];
    if (!card) return;
    const next = document.createElement('template');
    next.innerHTML = missionCard(mission, index, pilots || Object.keys(mission.pilots), P).trim();
    const fresh = next.content.firstChild;
    if (card.className !== fresh.className) card.className = fresh.className;
    if (card.innerHTML !== fresh.innerHTML) card.innerHTML = fresh.innerHTML;
  }

  root.CampaignBoard = { render, renderActive, ACTIONS, PILOTS };
}(window));
