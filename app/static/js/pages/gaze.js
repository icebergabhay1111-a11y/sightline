/* Gaze session review: timeline, period details with reviewer tags, per-question summary, exports.
   Everything shown is a measurement or a model estimate of visible eye/head movement. Nothing here is a judgement
   about the person; reviewers add their own notes using four neutral tags and nothing is ever tagged automatically. */
(function () {
  const { h, svg, api, fmtTime, demoBadge, can, empty, field, toast, fail, confirmDialog, badge, download } = App;
  const COL = { left: '#6aa3ff', up: '#6aa3ff', center: '#8fa0b6', right: '#f2b441', down: '#f2b441', unavailable: null };
  const MARK_COL = { question: '#f2b441', manual: '#4cc38a', pause: '#8fa0b6', resume: '#8fa0b6', calibration: '#a58bff', camera_lost: '#ef6a6a', consent_withdrawn: '#ef6a6a' };
  const TAG_COL = { review_later: '#a58bff', technical_issue: '#ef6a6a', context_note: '#4cc9d6', not_relevant: '#64758b' };
  const s1 = (ms) => (ms / 1000).toFixed(1) + ' s';
  const pct = (v) => (v == null ? '-' : v + '%');

  function lowerBound(arr, t) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].timestamp_ms < t) lo = m + 1; else hi = m; } return lo; }

  /* Contiguous run of the same combined label around sample i (a "period"). */
  function periodAt(samples, i, interval) {
    const key = (s) => s.horizontal_label + '/' + s.vertical_label;
    const k = key(samples[i]);
    let a = i, b = i;
    while (a > 0 && key(samples[a - 1]) === k && samples[a].timestamp_ms - samples[a - 1].timestamp_ms <= 2.5 * interval) a--;
    while (b < samples.length - 1 && key(samples[b + 1]) === k && samples[b + 1].timestamp_ms - samples[b].timestamp_ms <= 2.5 * interval) b++;
    return { a, b, start: samples[a].timestamp_ms, end: samples[b].timestamp_ms + interval };
  }

  function timeline({ samples, hr, markers, annotations, interval, range, selected, onPick }) {
    const W = 1000, L = 92, R = 12, rows = [['Horizontal', 22], ['Vertical', 22], ['Tracking conf.', 46]];
    if (hr.length) rows.push(['Heart rate', 46]);
    let y = 18;
    const rowY = rows.map(([, hh]) => { const r = y; y += hh + 8; return r; });
    const H = y + 18;
    const [t0, t1] = range;
    const X = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const els = [svg('defs', null, svg('pattern', { id: 'gz-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
      svg('rect', { width: 6, height: 6, fill: '#1a222d' }), svg('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#324258', 'stroke-width': 2 })))];
    rows.forEach(([label, hh], i) => {
      els.push(svg('text', { x: 4, y: rowY[i] + hh / 2 + 4, fill: '#8fa0b6', 'font-size': 11 }, label));
      els.push(svg('rect', { x: L, y: rowY[i], width: W - L - R, height: hh, fill: '#111820', stroke: '#263243' }));
    });
    const vis = samples.slice(Math.max(0, lowerBound(samples, t0) - 1), lowerBound(samples, t1) + 1);
    // label bands (run-length encoded)
    ['horizontal_label', 'vertical_label'].forEach((k, ri) => {
      let i = 0;
      while (i < vis.length) {
        let j = i;
        while (j + 1 < vis.length && vis[j + 1][k] === vis[i][k] && vis[j + 1].timestamp_ms - vis[j].timestamp_ms <= 2.5 * interval) j++;
        const a = Math.max(t0, vis[i].timestamp_ms), b = Math.min(t1, vis[j].timestamp_ms + interval);
        if (b > a) els.push(svg('rect', { x: X(a), y: rowY[ri] + 1, width: Math.max(0.6, X(b) - X(a)), height: rows[ri][1] - 2, fill: COL[vis[i][k]] || 'url(#gz-hatch)' }, svg('title', null, `${vis[i][k]} ${s1(a)}-${s1(b)}`)));
        i = j + 1;
      }
    });
    // confidence line with the 0.5 threshold
    const line = (vals, row, lo, hi, color) => {
      const [, hh] = rows[row];
      const pts = [];
      let seg = [];
      vals.forEach(([t, v], idx) => {
        if (v == null || (idx && t - vals[idx - 1][0] > 2.5 * Math.max(interval, row === 3 ? 1500 : 0))) { if (seg.length) pts.push(seg); seg = []; }
        if (v != null) seg.push(`${X(t).toFixed(1)},${(rowY[row] + hh - ((v - lo) / (hi - lo || 1)) * (hh - 4) - 2).toFixed(1)}`);
      });
      if (seg.length) pts.push(seg);
      pts.forEach((p) => els.push(svg('polyline', { points: p.join(' '), fill: 'none', stroke: color, 'stroke-width': 1.3 })));
    };
    const cy = rowY[2] + rows[2][1] - 0.5 * (rows[2][1] - 4) - 2;
    els.push(svg('line', { x1: L, x2: W - R, y1: cy, y2: cy, stroke: '#64758b', 'stroke-dasharray': '3 3' }));
    els.push(svg('text', { x: W - R - 2, y: cy - 3, fill: '#64758b', 'font-size': 9, 'text-anchor': 'end' }, 'min 0.5'));
    line(vis.map((s) => [s.timestamp_ms, s.tracking_confidence]), 2, 0, 1, '#4cc9d6');
    if (hr.length) {
      const hv = hr.filter((r) => r.timestamp_ms >= t0 - 2000 && r.timestamp_ms <= t1 + 2000);
      const lo = Math.min(...hr.map((r) => r.bpm)) - 3, hi = Math.max(...hr.map((r) => r.bpm)) + 3;
      line(hv.map((r) => [r.timestamp_ms, r.bpm]), 3, lo, hi, '#ef6a6a');
      els.push(svg('text', { x: L + 3, y: rowY[3] + 10, fill: '#64758b', 'font-size': 9 }, `${lo}-${hi} bpm`));
    }
    // reviewer annotations (shaded) and markers
    annotations.forEach((a) => {
      const a0 = Math.max(t0, a.start_ms), a1 = Math.min(t1, a.end_ms);
      if (a1 >= a0) els.push(svg('rect', { x: X(a0), y: 14, width: Math.max(2, X(a1) - X(a0)), height: H - 30, fill: TAG_COL[a.tag], opacity: 0.18 }, svg('title', null, `${a.tag_label}: ${a.note || ''}`)));
    });
    markers.filter((mk) => mk.timestamp_ms >= t0 && mk.timestamp_ms <= t1).forEach((mk) => {
      const x = X(mk.timestamp_ms);
      els.push(svg('line', { x1: x, x2: x, y1: 12, y2: H - 16, stroke: MARK_COL[mk.marker_type] || '#aaa', 'stroke-width': mk.marker_type === 'question' ? 1.6 : 1, 'stroke-dasharray': mk.marker_type === 'question' ? null : '3 3' }, svg('title', null, `${s1(mk.timestamp_ms)} ${mk.marker_type}: ${mk.text}`)));
      if (mk.marker_type === 'question') els.push(svg('text', { x: x + 2, y: 10, fill: '#f2b441', 'font-size': 10 }, 'Q' + (mk.question_marker_id ?? '')));
    });
    if (selected) els.push(svg('rect', { x: X(Math.max(t0, selected.start)), y: 14, width: Math.max(2, X(Math.min(t1, selected.end)) - X(Math.max(t0, selected.start))), height: H - 30, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.5 }));
    // time axis
    const span = t1 - t0, step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => span / 1000 / s <= 10) || 1200;
    for (let s = Math.ceil(t0 / 1000 / step) * step; s * 1000 <= t1; s += step) els.push(svg('text', { x: X(s * 1000), y: H - 3, fill: '#64758b', 'font-size': 10, 'text-anchor': 'middle' }, s + ' s'));
    const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'gaze-timeline', role: 'img', 'aria-label': 'Gaze observation timeline' }, ...els);
    el.addEventListener('click', (e) => {
      const r = el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      if (x < L || x > W - R) return;
      onPick(t0 + ((x - L) / (W - L - R)) * (t1 - t0));
    });
    return el;
  }

  App.pages.gazeView = async (root, ctx) => {
    const id = ctx.parts[1];
    let s = await api('/api/gaze/sessions/' + id);
    const D = s.disclaimers;
    const interval = s.summary.sample_interval_ms || 100;
    const end = s.samples.length ? s.samples[s.samples.length - 1].timestamp_ms + interval : 1000;
    let range = [0, end], selected = null;
    const tlHost = h('div'), detail = h('div'), annList = h('div');
    const qtext = {};
    s.markers.forEach((mk) => { if (mk.marker_type === 'question' && mk.question_marker_id != null && !(mk.question_marker_id in qtext)) qtext[mk.question_marker_id] = mk.text; });
    const applyRange = () => {
      const v = rangeSel.value;
      if (!v) range = [0, end];
      else { const q = s.summary.per_question.find((x) => String(x.question_marker_id) === v); range = [q.start_ms, q.end_ms + interval]; }
      paintTimeline();
    };
    const rangeSel = h('select', { 'aria-label': 'Timeline range', onchange: applyRange }, h('option', { value: '' }, 'Whole session'), s.summary.per_question.filter((q) => q.question_marker_id != null).map((q) => h('option', { value: q.question_marker_id }, `Question ${q.question_marker_id}`)));

    function paintTimeline() {
      tlHost.replaceChildren(timeline({ samples: s.samples, hr: s.heart_rate, markers: s.markers, annotations: s.annotations, interval, range, selected, onPick: pick }),
        h('div', { class: 'legend' }, h('span', null, h('i', { style: 'background:#6aa3ff' }), 'left / up'), h('span', null, h('i', { style: 'background:#8fa0b6' }), 'center'),
          h('span', null, h('i', { style: 'background:#f2b441' }), 'right / down'), h('span', null, h('i', { style: 'background:#324258' }), 'not reliably measurable'),
          h('span', null, h('i', { style: 'background:#f2b441;height:2px' }), 'question marker'), h('span', null, h('i', { style: 'background:#4cc38a;height:2px' }), 'manual marker'),
          h('span', null, h('i', { style: 'background:#a58bff;opacity:.5' }), 'reviewer annotation')));
    }

    function pick(t) {
      if (!s.samples.length) return;
      let i = lowerBound(s.samples, t);
      if (i >= s.samples.length || (i > 0 && t - s.samples[i - 1].timestamp_ms < s.samples[i].timestamp_ms - t)) i = Math.max(0, i - 1);
      selected = periodAt(s.samples, i, interval);
      paintTimeline(); paintDetail(s.samples[i]);
    }

    function paintDetail(x) {
      const p = selected;
      const hrNear = s.heart_rate.length ? s.heart_rate.reduce((best, r) => (Math.abs(r.timestamp_ms - x.timestamp_ms) < Math.abs(best.timestamp_ms - x.timestamp_ms) ? r : best)) : null;
      const avail = x.horizontal_label !== 'unavailable';
      const f = (v, d = 2) => (v == null ? '-' : (+v).toFixed(d));
      const rows = [
        ['Selected sample', s1(x.timestamp_ms)], ['Period (same labels)', `${s1(p.start)} to ${s1(p.end)} (${s1(p.end - p.start)})`],
        ['Horizontal / vertical label *', avail ? `${x.horizontal_label} / ${x.vertical_label}` : 'Not reliably measurable'],
        ['Offsets h / v *', avail ? `${f(x.horizontal_offset)} / ${f(x.vertical_offset)}` : '-'], ['Tracking confidence *', f(x.tracking_confidence)],
        ['Quality flags', x.quality_flags.join(', ') || 'none'], ['Face visible / eyes closed', `${x.face_visible ? 'yes' : 'no'} / ${x.eyes_closed ? 'yes' : 'no'}`],
        ['Head yaw / pitch / roll (deg)', `${f(x.head_yaw, 1)} / ${f(x.head_pitch, 1)} / ${f(x.head_roll, 1)}`], ['Label held for', s1(x.stability_ms)],
        ['Linked question', x.question_marker_id != null ? `Q${x.question_marker_id}: ${qtext[x.question_marker_id] || ''}` : 'none'],
        hrNear ? ['Nearest heart-rate reading', `${hrNear.bpm} bpm at ${s1(hrNear.timestamp_ms)}`] : null,
      ].filter(Boolean);
      const startIn = h('input', { type: 'number', step: '0.1', min: 0, value: (p.start / 1000).toFixed(1) });
      const endIn = h('input', { type: 'number', step: '0.1', min: 0, value: (p.end / 1000).toFixed(1) });
      const tag = h('select', null, h('option', { value: '' }, 'Choose a tag...'), Object.entries(s.review_tags).map(([k, v]) => h('option', { value: k }, v)));
      const note = h('textarea', { rows: 3, maxLength: 2000, placeholder: 'Your note (optional)' });
      const save = h('button', { class: 'btn small primary', onclick: async () => {
        if (!tag.value) return toast('Choose one of the four tags', 'err');
        const a = Math.round(+startIn.value * 1000), b = Math.round(+endIn.value * 1000);
        if (!(b >= a)) return toast('End must not be before start', 'err');
        save.disabled = true;
        try {
          await api(`/api/gaze/sessions/${id}/annotations`, { method: 'POST', json: { start_ms: a, end_ms: b, tag: tag.value, note: note.value } });
          s = await api('/api/gaze/sessions/' + id); toast('Annotation saved', 'ok'); paintTimeline(); paintAnn(); note.value = ''; tag.value = '';
        } catch (e) { fail(e); }
        save.disabled = false;
      } }, 'Save annotation');
      detail.replaceChildren(h('div', { class: 'card' }, h('h3', null, 'Period details'),
        h('table', null, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('td', { class: 'muted' }, k), h('td', null, v))))),
        h('p', { class: 'dim', style: 'font-size:11.5px;margin:6px 0 0' }, '* model output (estimated from face-mesh landmarks)'),
        can('investigator') ? h('div', { style: 'margin-top:12px' }, h('h3', null, 'Reviewer annotation ', App.sourceTag('human')),
          h('div', { class: 'grid g2', style: 'gap:8px' }, field('From (s)', startIn), field('To (s)', endIn)),
          h('div', { style: 'margin-top:8px' }, field('Tag', tag)), h('div', { style: 'margin-top:8px' }, field('Note', note)), h('div', { style: 'margin-top:8px' }, save)) : null));
    }

    function paintAnn() {
      annList.replaceChildren(s.annotations.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Time', 'Tag', 'Note', 'By', ''].map((t) => h('th', null, t)))),
        h('tbody', null, s.annotations.map((a) => h('tr', null, h('td', { class: 'mono' }, `${s1(a.start_ms)}-${s1(a.end_ms)}`),
          h('td', null, h('span', { class: 'badge', style: `background:${TAG_COL[a.tag]}22;color:${TAG_COL[a.tag]};border-color:${TAG_COL[a.tag]}55` }, a.tag_label)),
          h('td', null, a.note || h('span', { class: 'dim' }, '(no note)')), h('td', { class: 'dim' }, `${a.created_by_name || '-'} ${fmtTime(a.created_at)}`),
          h('td', null, can('investigator') ? h('button', { class: 'btn small', onclick: async () => { try { await api('/api/gaze/annotations/' + a.id, { method: 'DELETE' }); s = await api('/api/gaze/sessions/' + id); paintTimeline(); paintAnn(); } catch (e) { fail(e); } } }, 'Delete') : null)))))) : empty('No reviewer annotations yet. Click the timeline to select a period.'));
    }

    const o = s.summary.overall || {};
    const kv = (rows) => h('table', null, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('td', { class: 'muted' }, k), h('td', null, String(v))))));
    const cal = s.calibration || {};
    const perQ = h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Q', 'Question marker', 'Duration', 'Usable / unavailable', 'Gaze shifts *', 'Blinks', 'Eyes closed', 'Dominant direction *', 'Heart rate', 'Data-quality warnings'].map((t) => h('th', null, t)))),
      h('tbody', null, s.summary.per_question.map((q) => h('tr', { class: 'click', onclick: () => { rangeSel.value = q.question_marker_id ?? ''; applyRange(); tlHost.scrollIntoView({ behavior: 'smooth' }); } },
        h('td', null, q.question_marker_id ?? '-'), h('td', null, q.question_text || '-'), h('td', null, s1(q.duration_ms)), h('td', null, `${q.usable_pct}% / ${q.unavailable_pct}%`),
        h('td', null, q.gaze_shift_count), h('td', null, q.blink_count), h('td', null, s1(q.eye_closed_total_ms) + (q.prolonged_closure_count ? ` (${q.prolonged_closure_count} over 1 s)` : '')),
        h('td', null, q.dominant_direction ? `${q.dominant_direction.horizontal} (${q.dominant_direction.horizontal_share_pct}%) / ${q.dominant_direction.vertical} (${q.dominant_direction.vertical_share_pct}%)` : h('span', { class: 'dim', title: q.dominant_note }, 'not shown (usable < 60%)')),
        h('td', null, q.heart_rate ? `mean ${q.heart_rate.mean_bpm} (${q.heart_rate.min_bpm}-${q.heart_rate.max_bpm}) bpm` : '-'),
        h('td', null, q.quality_warnings.length ? q.quality_warnings.map((w) => h('div', { class: 'gaze-warn' }, w)) : h('span', { class: 'dim' }, 'none')))))));

    const exp = (url) => download(url);
    root.append(
      h('div', { class: 'row sp' }, h('div', null, h('div', { class: 'row' }, h('h1', { style: 'margin:0' }, `Gaze session #${id}`), demoBadge(s.is_demo), badge(s.source_type === 'webcam' ? 'webcam' : 'file', 'b-mut')),
        h('p', { class: 'sub', style: 'margin-top:4px' }, `${s.case_number} - ${s.source_name || s.source_type} - ${s1(s.duration_ms)} - ${s.sample_count} samples - saved ${fmtTime(s.created_at)} by ${s.created_by_name || '-'}`)),
        h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/cases/' + s.case_id + '?tab=Observations' }, 'Open case'), s.interview_id ? h('a', { class: 'btn', href: '#/interview/' + s.interview_id }, 'Open interview') : null,
          can('investigator') ? h('button', { class: 'btn danger', onclick: async () => { if (!(await confirmDialog('Delete this gaze session and all of its samples, markers, heart-rate readings and annotations?', 'Delete'))) return; try { await api('/api/gaze/sessions/' + id, { method: 'DELETE' }); toast('Deleted', 'ok'); location.hash = '#/cases/' + s.case_id + '?tab=Observations'; } catch (e) { fail(e); } } }, 'Delete') : null)),
      h('div', { class: 'notice warn', style: 'margin-bottom:8px' }, D.report),
      h('p', { class: 'dim', style: 'font-size:12px;margin:0 0 16px' }, `${D.prototype} ${D.direction} ${D.convention} ${D.confidence}`),
      h('div', { class: 'grid g-main' },
        h('div', null,
          h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h3', { style: 'margin:0' }, 'Timeline ', App.sourceTag('model')), h('div', { class: 'row' }, rangeSel)), h('div', { style: 'margin-top:8px' }, tlHost),
            h('p', { class: 'dim', style: 'font-size:12px;margin:6px 0 0' }, 'Click anywhere on the timeline to see the measurements for that period and add a reviewer note. Hatched areas are periods where direction was not reliably measurable.')),
          h('div', { class: 'card' }, h('h3', null, 'Per-question summary ', App.sourceTag('measured'), ' ', App.sourceTag('model')), perQ,
            h('p', { class: 'dim', style: 'font-size:11.5px;margin:6px 0' }, '* model output. Dominant direction is shown only when usable tracking covers at least 60% of the question\'s samples. Click a row to zoom the timeline.'),
            h('div', { class: 'notice info gaze-disclaimer' }, s.summary.disclaimer),
            s.heart_rate.length ? h('p', { class: 'dim', style: 'font-size:12px;margin:8px 0 0' }, D.heart_rate) : null),
          h('div', { class: 'card' }, h('h3', null, 'Reviewer annotations ', App.sourceTag('human')), annList),
          h('div', { class: 'card' }, h('h3', null, 'Markers ', App.sourceTag('measured')), s.markers.length ? h('div', { class: 'tablewrap', style: 'max-height:240px;overflow:auto' }, h('table', null, h('tbody', null, s.markers.map((mk) => h('tr', null,
            h('td', { class: 'mono' }, s1(mk.timestamp_ms)), h('td', null, h('span', { class: 'badge', style: `color:${MARK_COL[mk.marker_type]};border-color:${MARK_COL[mk.marker_type]}55` }, mk.marker_type.replace('_', ' '))), h('td', null, mk.text), h('td', { class: 'dim' }, mk.question_marker_id != null ? 'Q' + mk.question_marker_id : '')))))) : empty('No markers.'))),
        h('div', null, detail,
          h('div', { class: 'card' }, h('h3', null, 'Overall ', App.sourceTag('measured')), kv([['Duration', s1(o.duration_ms || 0)], ['Samples', o.samples], ['Usable tracking', pct(o.usable_pct)], ['Face visible', pct(o.face_visible_pct)],
            ['Gaze shifts (model output)', o.gaze_shift_count], ['Blinks', o.blink_count], ['Eye closures over 1 s', o.prolonged_closure_count], ['Heart-rate readings', s.heart_rate.length]])),
          h('div', { class: 'card' }, h('h3', null, 'Consent ', App.sourceTag('human')),
            [s.consent, s.hr_consent].filter(Boolean).map((c) => h('div', { class: 'list-item', style: 'display:block' }, h('div', null, h('b', null, c.scope === 'heart_rate' ? 'Heart rate' : 'Gaze observation'), ` #${c.id} - ${c.subject_ref}${c.form_ref ? ', form ' + c.form_ref : ''}`),
              h('div', { class: 'dim', style: 'font-size:12px' }, `Confirmed ${fmtTime(c.confirmed_at)} (statement v${c.statement_version})`, c.withdrawn_at ? h('span', { style: 'color:var(--bad)' }, ` - withdrawn ${fmtTime(c.withdrawn_at)}`) : null)))),
          h('div', { class: 'card' }, h('h3', null, 'Session settings'), kv([['Calibration', cal.status + (cal.status === 'completed' ? ` (offset h ${cal.offset_h}, v ${cal.offset_v}; usable ${Math.round((cal.usable_fraction || 0) * 100)}%)` : '')],
            ['Glasses declared', s.glasses_declared ? 'yes' : 'no'], ['Settings version', s.settings_version], ['Software', `${s.software.library || '?'} ${s.software.version || ''}`], ['Model', s.software.model || '-'],
            ['Sampling', `${s.settings.sample_hz || '?'} Hz target, ${s.software.achieved_fps ?? '?'} achieved`], ['Smoothing', `exponential, alpha ${s.settings.ema_alpha}`],
            ['Hysteresis', `h ${s.settings.h_enter}/${s.settings.h_exit}, v ${s.settings.v_enter}/${s.settings.v_exit}, dwell ${s.settings.min_dwell_ms} ms`]])),
          h('div', { class: 'card' }, h('h3', null, 'Export'), h('div', { class: 'row' },
            h('button', { class: 'btn small', onclick: () => exp(`/api/gaze/sessions/${id}/export.csv`) }, 'Samples CSV'),
            s.heart_rate.length ? h('button', { class: 'btn small', onclick: () => exp(`/api/gaze/sessions/${id}/export.csv?kind=heart_rate`) }, 'Heart-rate CSV') : null,
            h('button', { class: 'btn small', onclick: () => exp(`/api/gaze/sessions/${id}/export.json`) }, 'JSON (versioned)'),
            h('a', { class: 'btn small', href: `#/reports?case=${s.case_id}` }, 'PDF case report')),
            h('p', { class: 'dim', style: 'font-size:11.5px;margin:6px 0 0' }, 'Exports contain numbers, labels, markers, consent metadata and annotations only - never images or video.')))));
    paintTimeline(); paintAnn();
    detail.replaceChildren(h('div', { class: 'card' }, h('h3', null, 'Period details'), h('p', { class: 'dim', style: 'margin:0' }, 'Click the timeline to select a period.')));
  };

  /* Small list used on the case page, the interview page and the observation lab. */
  App.gazeSessionList = async (q, compact) => {
    const rows = await api('/api/gaze/sessions?' + App.qs(q));
    if (!rows.length) return empty('No gaze observation sessions.');
    if (compact) return h('div', null, rows.map((r) => h('div', { class: 'list-item' }, h('a', { href: '#/gaze/' + r.id }, `#${r.id} ${r.source_type}`),
      h('span', { class: 'dim', style: 'font-size:12px;white-space:nowrap' }, `${s1(r.duration_ms)} - usable ${r.usable_pct == null ? '-' : r.usable_pct + '%'}${r.hr_count ? ' - HR' : ''}`))));
    return h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['#', 'Source', 'Duration', 'Usable', 'Heart rate', 'Notes', 'Saved'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((r) => h('tr', { class: 'click', onclick: () => (location.hash = '#/gaze/' + r.id) }, h('td', null, r.id, ' ', demoBadge(r.is_demo)),
        h('td', null, r.source_type === 'webcam' ? 'webcam' : r.source_name || 'file', r.interview_id ? h('span', { class: 'dim' }, ` (interview #${r.interview_id})`) : null), h('td', null, s1(r.duration_ms)),
        h('td', null, r.usable_pct == null ? '-' : r.usable_pct + '%'), h('td', null, r.hr_count ? `${r.hr_count} readings` : '-'), h('td', null, r.annotation_count || '-'), h('td', { class: 'dim' }, fmtTime(r.created_at)))))));
  };
})();
