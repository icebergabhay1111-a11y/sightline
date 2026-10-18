(function () {
  const { h, api, fmtTime, demoBadge, can, empty, field, toast, fail, confirmDialog } = App;
  const NOTICE = 'This module measures visible head, eye and facial-landmark movement. It does not determine whether someone is lying, nervous, stressed or guilty: no reliable facial sign of deception exists, and camera angle, lighting, occlusion, tracking failures and normal individual variation all change these numbers.';

  function clientSummary(series, events, duration) {
    const n = series.t.length;
    const tracked = n ? series.face.reduce((a, b) => a + b, 0) / n : 0;
    const count = (t) => events.filter((e) => e.type === t).length;
    const rng = (k) => { const v = series[k].filter((x) => x != null); return v.length ? [Math.min(...v), Math.max(...v)] : null; };
    const blinks = count('blink');
    return { samples: n, tracked_fraction: tracked, blink_count: blinks, blink_rate_per_min: tracked * duration >= 10 ? blinks / ((tracked * duration) / 60) : null,
      head_turn_count: count('head_turn'), movement_burst_count: count('movement_burst'), tracking_lost_count: count('tracking_lost'), yaw_range: rng('yaw'), pitch_range: rng('pitch') };
  }

  function summaryTable(s) {
    const f = (r) => (r ? `${(+r[0]).toFixed(1)} to ${(+r[1]).toFixed(1)}` : '-');
    const rows = [['Samples', s.samples], ['Face tracked', `${Math.round((s.tracked_fraction || 0) * 100)}% of samples`], ['Blink events', s.blink_count],
      ['Blink events per minute of tracked time', s.blink_rate_per_min == null ? 'n/a (under 10 s tracked)' : (+s.blink_rate_per_min).toFixed(1)],
      ['Head turns (|yaw| > 20 deg, >= 0.5 s)', s.head_turn_count], ['Landmark-motion bursts', s.movement_burst_count], ['Tracking-lost periods', s.tracking_lost_count],
      ['Yaw range (deg)', f(s.yaw_range)], ['Pitch range (deg)', f(s.pitch_range)]];
    if (s.mean_brightness != null) rows.push(['Mean frame brightness (0-255)', s.mean_brightness]);
    return h('table', null, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('td', { class: 'muted' }, k), h('td', null, String(v))))));
  }

  function eventList(events) {
    const types = [...new Set(events.map((e) => e.type))];
    const body = h('div');
    const draw = (type) => {
      const list = events.filter((e) => (type ? e.type === type : e.type !== 'blink'));
      body.replaceChildren(list.length ? h('div', { class: 'tablewrap', style: 'max-height:280px;overflow:auto' }, h('table', null, h('thead', null, h('tr', null, ['t (s)', 'Event', 'Duration', 'Detail'].map((x) => h('th', null, x)))),
        h('tbody', null, list.map((e) => { const c = Charts.EVENT_COLOR[e.type] || '#aaa'; return h('tr', null, h('td', { class: 'mono' }, e.t.toFixed(1)),
          h('td', null, h('span', { class: 'badge', style: `background:${c}22;color:${c};border-color:${c}55` }, e.type.replace(/_/g, ' '))),
          h('td', null, e.duration ? e.duration.toFixed(2) + ' s' : '-'), h('td', { class: 'muted' }, e.detail || '')); })))) : empty('No events of this kind.'));
    };
    draw('');
    return h('div', null, h('div', { class: 'toolbar' }, h('select', { 'aria-label': 'Event type', onchange: (e) => draw(e.target.value) }, h('option', { value: '' }, 'All events except blinks'),
      types.map((t) => h('option', { value: t }, `${t.replace(/_/g, ' ')} (${events.filter((e) => e.type === t).length})`)))), body);
  }

  function charts(series, events, duration) {
    const t = series.t;
    return h('div', null,
      h('div', { class: 'card', style: 'margin-bottom:12px' }, Charts.line({ t, series: [{ label: 'yaw (deg)', values: series.yaw, color: '#4cc9d6' }, { label: 'pitch (deg)', values: series.pitch, color: '#f2b441' }, { label: 'roll (deg)', values: series.roll || [], color: '#a58bff' }], events, duration, height: 150, title: 'Head orientation over time' })),
      h('div', { class: 'card', style: 'margin-bottom:12px' }, Charts.line({ t, series: [{ label: 'landmark motion (eye-distances per second; head + face)', values: series.energy, color: '#6aa3ff', min: 0 }], events, duration, height: 120, title: 'Landmark motion' })),
      h('div', { class: 'card' }, Charts.line({ t, series: [{ label: 'face tracked (0/1)', values: series.face, color: '#4cc38a', min: 0, max: 1 }, { label: 'frame brightness (0-255)', values: series.brightness, color: '#8fa0b6', min: 0, max: 255 }], events, duration, height: 110, title: 'Tracking and image quality' })),
      Charts.eventLegend(),
      h('p', { class: 'dim', style: 'font-size:12px' }, 'Shaded bands are events with a duration; short ticks along the bottom are blink events; dashed green lines are markers (for example "question shown").'));
  }

  // ------------------------------------------------------------------ Observation lab
  App.pages.observe = async (root, ctx) => {
    const { options } = await App.caseOptions(ctx.query.case || '');
    const caseSel = h('select', null, h('option', { value: '' }, 'Choose a case...'), options);
    const srcWeb = h('input', { type: 'radio', name: 'obs-src', value: 'webcam', checked: true }), srcFile = h('input', { type: 'radio', name: 'obs-src', value: 'file' });
    const fileIn = h('input', { type: 'file', accept: 'video/*', disabled: true });
    const consent = h('input', { type: 'checkbox', name: 'consent' });
    const consentLbl = h('label', { class: 'chk' }, consent, 'The subject consents to webcam capture and analysis. Frames are processed in this browser and are never uploaded or stored.');
    const demo = h('input', { type: 'checkbox', checked: true });
    const markIn = h('input', { type: 'text', placeholder: 'Marker text, e.g. "Question 3 asked"', maxLength: 100 });
    const markBtn = h('button', { class: 'btn small', disabled: true }, 'Add marker');
    const startBtn = h('button', { class: 'btn primary' }, 'Start'), stopBtn = h('button', { class: 'btn', disabled: true }, 'Stop');
    const status = h('div', { class: 'muted', style: 'font-size:12px' });
    const view = ObserverUI.view({ mirror: true });
    const liveChart = h('div', null, h('p', { class: 'dim' }, 'Start a session to see live measurements.'));
    const feed = h('div'), review = h('div'), recent = h('div');
    let observer = null, chartTimer = null, result = null;
    [srcWeb, srcFile].forEach((r) => (r.onchange = () => { fileIn.disabled = !srcFile.checked; consentLbl.style.opacity = srcFile.checked ? 0.55 : 1; }));

    async function loadRecent() {
      if (!caseSel.value) { recent.replaceChildren(h('p', { class: 'dim' }, 'Choose a case to see its saved observations.')); return; }
      const ob = await api('/api/observations?case_id=' + caseSel.value);
      recent.replaceChildren(ob.length ? ob.slice(0, 10).map((o) => h('div', { class: 'list-item' }, h('a', { href: '#/observation/' + o.id }, `#${o.id} ${o.source === 'webcam' ? 'webcam' : o.source_name || 'video file'}`),
        h('span', { class: 'dim', style: 'font-size:12px;white-space:nowrap' }, `${o.duration_s.toFixed(0)} s - ${fmtTime(o.created_at)}`))) : h('p', { class: 'dim' }, 'None yet.'));
    }
    caseSel.onchange = () => { loadRecent().catch(fail); loadGaze().catch(fail); };

    // Gaze observation: separate module with its own consent; shares the camera lock with the observer above.
    const gazeOn = !(App.meta && App.meta.gaze_enabled === false);
    const gazeRecent = h('div');
    async function loadGaze() {
      if (!gazeOn) return;
      gazeRecent.replaceChildren(caseSel.value ? await App.gazeSessionList({ case_id: caseSel.value }, true) : h('p', { class: 'dim' }, 'Choose a case to see its gaze sessions.'));
    }
    const gazeCtl = gazeOn && can('investigator') ? GazeUI.capture({ caseId: () => caseSel.value, allowFile: true, questionButton: true, isDemo: () => demo.checked, onSaved: () => loadGaze().catch(fail) }) : null;

    function drawLive() {
      if (!observer || !observer.series) return;
      const S = observer.series, n = S.t.length, from = Math.max(0, n - 600);
      const sl = (k) => S[k].slice(from);
      const t = sl('t');
      if (!t.length) return;
      const t0 = t[0], rel = t.map((x) => x - t0);
      liveChart.replaceChildren(Charts.line({ t: rel, duration: Math.max(rel[rel.length - 1], 1), height: 120, title: `Last ${Math.round(rel[rel.length - 1])} s: yaw, pitch and landmark motion`,
        events: observer.events.filter((e) => e.t >= t0).map((e) => ({ ...e, t: e.t - t0 })),
        series: [{ label: 'yaw', values: sl('yaw'), color: '#4cc9d6' }, { label: 'pitch', values: sl('pitch'), color: '#f2b441' }, { label: 'motion', values: sl('energy'), color: '#6aa3ff', min: 0 }] }));
    }
    function addFeed(e) {
      if (e.type === 'blink') return;
      feed.prepend(h('div', { class: 'list-item' }, h('span', null, h('b', null, e.type.replace(/_/g, ' ')), ' ', h('span', { class: 'muted' }, e.detail || '')), h('span', { class: 'mono dim' }, e.t.toFixed(1) + ' s')));
      while (feed.children.length > 10) feed.lastChild.remove();
    }

    startBtn.onclick = async () => {
      const fromFile = srcFile.checked;
      if (!caseSel.value) return toast('Choose a case first', 'err');
      if (fromFile && !fileIn.files[0]) return toast('Choose a video file', 'err');
      if (!fromFile && !consent.checked) return toast("Confirm the subject's consent to webcam capture first", 'err');
      startBtn.disabled = true; review.replaceChildren(); feed.replaceChildren(); result = null;
      status.textContent = 'Loading face model (first use needs internet) ...';
      try {
        let last = 0;
        observer = new ObserverUI.Observer({ video: view.video, canvas: view.canvas, onEvent: addFeed, onEnded: () => finish(),
          onUpdate: (L) => { const n = performance.now(); if (n - last > 250) { last = n; view.update(L); } } });
        view.bindToggles(observer);
        view.setMirror(!fromFile);
        await observer.start(fromFile ? { source: 'file', file: fileIn.files[0] } : { source: 'webcam' });
        stopBtn.disabled = false; markBtn.disabled = false;
        status.textContent = fromFile ? 'Analysing the video in your browser (plays in real time)...' : 'Observing. Video stays in this browser; only measurements can be saved.';
        chartTimer = setInterval(drawLive, 700);
      } catch (e) { fail(e); startBtn.disabled = false; status.textContent = ''; if (observer) observer.stop(); observer = null; }
    };
    markBtn.onclick = () => { if (observer) { observer.mark(markIn.value.trim() || 'marker'); markIn.value = ''; } };

    function finish() {
      if (!observer) return;
      clearInterval(chartTimer);
      result = observer.stop();
      observer = null; startBtn.disabled = false; stopBtn.disabled = true; markBtn.disabled = true; status.textContent = '';
      view.showPlaceholder();
      if (!result || result.series.t.length < 5) { review.replaceChildren(empty('Too little data was captured to review.')); return; }
      const note = h('textarea', { rows: 3, placeholder: 'Optional interpretation notes (human-entered), e.g. "camera was low, subject wore glasses"' });
      const sum = clientSummary(result.series, result.events, result.duration_s);
      const saveBtn = h('button', { class: 'btn primary' }, 'Save to case');
      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        try {
          const o = await api('/api/observations', { method: 'POST', json: { case_id: +caseSel.value, consent_confirmed: result.source === 'webcam' ? consent.checked : false, is_demo: demo.checked, ...result } });
          if (note.value.trim()) await api('/api/observations/' + o.id, { method: 'PATCH', json: { interpretation_note: note.value } });
          toast('Observation saved to case', 'ok');
          location.hash = '#/observation/' + o.id;
        } catch (e) { fail(e); saveBtn.disabled = false; }
      };
      review.replaceChildren(h('div', { class: 'card', style: 'margin-top:16px' },
        h('div', { class: 'row sp' }, h('h2', { style: 'margin:0' }, 'Review before saving'), h('span', { class: 'dim' }, `${result.duration_s.toFixed(0)} s - ${result.series.t.length} samples`)),
        h('h3', { style: 'margin-top:12px' }, 'Measured ', App.sourceTag('measured')), summaryTable(sum), h('div', { style: 'margin-top:12px' }, charts(result.series, result.events, result.duration_s)),
        h('h3', { style: 'margin-top:12px' }, 'Event timeline ', App.sourceTag('measured')), eventList(result.events),
        h('h3', { style: 'margin-top:12px' }, 'Interpretation ', App.sourceTag('human')), note,
        h('div', { class: 'row', style: 'margin-top:12px' }, can('investigator') ? saveBtn : h('span', { class: 'dim' }, 'Viewers cannot save.'),
          h('button', { class: 'btn', onclick: () => { result = null; review.replaceChildren(); toast('Discarded'); } }, 'Discard'))));
      loadRecent().catch(fail);
    }
    stopBtn.onclick = finish;

    root.append(h('h1', null, 'Observation lab'), h('p', { class: 'sub' }, 'Visualise the face mesh, head orientation, blink events and landmark motion from a webcam or an uploaded video.',
      gazeCtl ? h('span', null, ' Gaze direction measurement is a separate module with its own consent: ', h('a', { href: 'javascript:void 0', onclick: () => document.getElementById('gaze-lab').scrollIntoView({ behavior: 'smooth' }) }, 'Gaze observation')) : null),
      h('div', { class: 'notice warn', style: 'margin-bottom:16px' }, NOTICE),
      h('div', { class: 'grid g-main' },
        h('div', null, h('div', { class: 'card' }, view.el, h('div', { class: 'row', style: 'margin-top:10px' }, startBtn, stopBtn, status),
          h('div', { class: 'row', style: 'margin-top:10px;flex-wrap:nowrap' }, markIn, markBtn)),
          h('div', { class: 'card' }, h('h3', null, 'Live view ', App.sourceTag('measured')), liveChart), review),
        h('div', null, h('div', { class: 'card' }, h('h3', null, 'Session setup'),
          h('div', { class: 'grid', style: 'gap:10px' }, field('Case (needed to save)', caseSel),
            h('div', { class: 'row' }, h('label', { class: 'chk' }, srcWeb, 'Webcam'), h('label', { class: 'chk' }, srcFile, 'Video file')), field('Video file (processed locally, not uploaded)', fileIn),
            consentLbl, h('label', { class: 'chk' }, demo, 'Fictional / demonstration session'))),
          h('div', { class: 'card' }, h('h3', null, 'Events as they occur'), feed, h('p', { class: 'dim', style: 'font-size:12px;margin:6px 0 0' }, 'Blinks are counted but not listed here.')),
          h('div', { class: 'card' }, h('h3', null, 'Saved for this case'), recent),
          gazeOn ? h('div', { class: 'card' }, h('h3', null, 'Gaze sessions for this case'), gazeRecent) : null,
          h('div', { class: 'card' }, h('h3', null, 'About the measurements'),
            h('p', { class: 'muted', style: 'font-size:12.5px;margin:0' }, 'Head pose comes from the face-landmark transformation matrix. Blinks are eye-closure events from the eye-blink blendshapes (thresholds are saved with each record). Gaze values are iris-direction proxies that mix with head pose. Landmark motion is the average landmark displacement per second, normalised by eye distance, and includes head movement. The library exposes no per-frame tracking confidence, so face presence, brightness and sharpness are reported instead.')))),
      gazeCtl ? h('div', { id: 'gaze-lab', style: 'margin-top:16px' }, gazeCtl.el) : null);
    await loadRecent();
    await loadGaze();
    return () => { clearInterval(chartTimer); if (observer) { observer.stop(); observer = null; } if (gazeCtl) gazeCtl.destroy(); };
  };

  // ------------------------------------------------------------------ saved observation
  App.pages.observationView = async (root, ctx) => {
    const id = ctx.parts[1];
    const o = await api('/api/observations/' + id);
    const note = h('textarea', { rows: 4, disabled: !can('investigator'), placeholder: 'Human-entered interpretation or caveats...' }, o.interpretation_note || '');
    root.append(h('div', { class: 'row sp' }, h('div', null, h('div', { class: 'row' }, h('h1', { style: 'margin:0' }, `Observation #${id}`), demoBadge(o.is_demo)),
      h('p', { class: 'sub', style: 'margin-top:4px' }, `${o.source === 'webcam' ? 'Webcam session' : 'Video file: ' + (o.source_name || '')} - ${o.duration_s.toFixed(0)} s - saved ${fmtTime(o.created_at)}`)),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/cases/' + o.case_id + '?tab=Observations' }, 'Open case'), o.interview_id ? h('a', { class: 'btn', href: '#/interview/' + o.interview_id }, 'Open interview') : null,
        can('investigator') ? h('button', { class: 'btn danger', onclick: async () => { if (!(await confirmDialog('Delete this observation record?', 'Delete'))) return; try { await api('/api/observations/' + id, { method: 'DELETE' }); toast('Deleted', 'ok'); location.hash = '#/cases/' + o.case_id + '?tab=Observations'; } catch (e) { fail(e); } } }, 'Delete') : null)),
      h('div', { class: 'notice warn', style: 'margin-bottom:16px' }, NOTICE),
      h('div', { class: 'grid g-main' }, h('div', null, charts(o.series, o.events, o.duration_s)),
        h('div', null, h('div', { class: 'card' }, h('h3', null, 'Measured summary ', App.sourceTag('measured')), summaryTable(o.summary)),
          h('div', { class: 'card' }, h('h3', null, 'Interpretation ', App.sourceTag('human')), note,
            can('investigator') ? h('button', { class: 'btn small', style: 'margin-top:8px', onclick: async () => { try { await api('/api/observations/' + id, { method: 'PATCH', json: { interpretation_note: note.value } }); toast('Note saved', 'ok'); } catch (e) { fail(e); } } }, 'Save note') : null),
          h('div', { class: 'card' }, h('h3', null, 'Software'), h('p', { class: 'muted', style: 'font-size:12.5px;margin:0' }, `${o.software.library || '?'} ${o.software.version || ''}; model ${o.software.model || '?'}; about ${o.software.sample_fps || '?'} samples per second. ${o.software.note || ''}`)))),
      h('div', { class: 'card', style: 'margin-top:16px' }, h('h3', null, 'Event timeline ', App.sourceTag('measured')), eventList(o.events)));
  };
})();
