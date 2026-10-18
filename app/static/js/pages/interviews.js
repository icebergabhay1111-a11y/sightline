(function () {
  const { h, api, fmtTime, badge, demoBadge, can, empty, field, modal, confirmDialog, toast, fail } = App;

  function highlight(text, terms) {
    if (!terms || !terms.length) return text;
    const re = new RegExp('\\b(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'gi');
    const out = [];
    let last = 0, m;
    while ((m = re.exec(text))) { out.push(text.slice(last, m.index), h('mark', { class: 'hl' }, m[0])); last = m.index + m[0].length; }
    out.push(text.slice(last));
    return out;
  }

  async function newInterviewModal(presetCase) {
    const { options } = await App.caseOptions(presetCase);
    const caseSel = h('select', null, h('option', { value: '' }, 'Choose a case...'), options);
    const subj = h('input', { type: 'text', maxLength: 80, placeholder: 'Reference code, not a real name (e.g. S-01)' });
    const consent = h('input', { type: 'checkbox', name: 'consent' });
    const note = h('input', { type: 'text', maxLength: 500, placeholder: 'Consent form number or legal authority' });
    const demo = h('input', { type: 'checkbox', checked: true });
    modal({ title: 'New structured interview', body: h('div', { class: 'grid' }, field('Case', caseSel), field('Subject reference', subj), field('Consent / authority note', note),
      h('label', { class: 'chk' }, consent, 'The subject has given documented consent (or there is valid legal authority) to be interviewed and recorded for this session.'),
      h('label', { class: 'chk' }, demo, 'This is a fictional / demonstration interview'),
      h('p', { class: 'dim', style: 'font-size:12px;margin:0' }, 'The current question set is copied into the interview. Edit questions in Settings; changes apply to new interviews only.')),
    actions: [{ label: 'Cancel' }, { label: 'Start interview', kind: 'primary', onClick: async () => {
      if (!caseSel.value || !subj.value.trim()) { toast('Choose a case and enter a subject reference', 'err'); return false; }
      if (!consent.checked) { toast('Consent or legal authority must be confirmed', 'err'); return false; }
      const r = await api('/api/interviews', { method: 'POST', json: { case_id: +caseSel.value, subject_ref: subj.value.trim(), consent_confirmed: true, consent_note: note.value, is_demo: demo.checked } });
      location.hash = '#/interview/' + r.id;
    } }] });
    subj.focus();
  }

  App.pages.interviews = async (root, ctx) => {
    const state = { case_id: ctx.query.case || '' };
    const { options } = await App.caseOptions(state.case_id, true);
    const list = h('div');
    const load = async () => {
      const rows = await api('/api/interviews' + (state.case_id ? '?case_id=' + state.case_id : ''));
      list.replaceChildren(rows.length ? h('div', { class: 'card tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['#', 'Case', 'Subject ref', 'Status', 'Answered', 'Follow-ups', 'Updated'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((i) => h('tr', { class: 'click', onclick: () => (location.hash = '#/interview/' + i.id) }, h('td', null, i.id), h('td', null, i.case_number), h('td', null, i.subject_ref, ' ', demoBadge(i.is_demo)),
          h('td', null, badge(i.status.replace('_', ' '), i.status === 'completed' ? 'b-ok' : 'b-warn')), h('td', null, `${i.answered}/${i.total}`), h('td', null, i.follow_ups), h('td', { class: 'dim' }, fmtTime(i.updated_at))))))) : empty('No interviews yet.'));
    };
    root.append(h('div', { class: 'row sp' }, h('div', null, h('h1', null, 'Structured interviews'), h('p', { class: 'sub' }, 'Ten configurable questions, one at a time, with saved progress, notes, follow-up flags, optional audio and a structured summary.')),
      can('investigator') ? h('button', { class: 'btn primary', onclick: () => newInterviewModal(state.case_id).catch(fail) }, '+ New interview') : null),
      h('div', { class: 'toolbar' }, h('select', { 'aria-label': 'Case', onchange: (e) => { state.case_id = e.target.value; load().catch(fail); } }, options),
        h('a', { href: '#/settings' }, 'Edit question set')), list);
    await load();
    if (ctx.query.new && can('investigator')) { history.replaceState(null, '', '#/interviews'); setTimeout(() => newInterviewModal(state.case_id).catch(fail), 0); }
  };

  App.pages.interviewRun = async (root, ctx) => {
    const id = ctx.parts[1];
    let iv = await api('/api/interviews/' + id);
    const c = await api('/api/cases/' + iv.case_id);
    const readOnly = () => iv.status === 'completed' || !can('investigator');
    let cur = iv.items.findIndex((i) => !i.response_text.trim());
    if (cur < 0) cur = 0;
    if (ctx.query.q) cur = Math.min(Math.max(+ctx.query.q - 1, 0), iv.items.length - 1);
    let dirty = false, timer = null, observer = null, recorder = null, recStream = null, saving = null;
    const main = h('div'), qlist = h('div'), obsHost = h('div'), summaryBox = h('div'), savedLbl = h('span', { class: 'dim', style: 'font-size:12px' });

    async function save() {
      clearTimeout(timer);
      if (saving) await saving;
      if (!dirty || readOnly()) return;
      const it = iv.items[cur];
      dirty = false;
      saving = api(`/api/interviews/${id}/items/${it.position}`, { method: 'PATCH', json: { response_text: it.response_text, notes: it.notes, follow_up: !!it.follow_up } })
        .then(() => { savedLbl.textContent = 'Saved ' + new Date().toLocaleTimeString(); paintList(); })
        .catch((e) => { dirty = true; savedLbl.textContent = 'Not saved'; fail(e); })
        .finally(() => { saving = null; });
      await saving;
    }
    const touch = () => { dirty = true; savedLbl.textContent = 'Unsaved changes...'; clearTimeout(timer); timer = setTimeout(save, 800); };
    async function go(i) {
      await save();
      cur = Math.min(Math.max(i, 0), iv.items.length - 1);
      if (observer && observer.running) observer.mark(`Question ${iv.items[cur].position} shown`);
      paintMain(); paintList();
    }

    function paintList() {
      const answered = iv.items.filter((i) => i.response_text.trim()).length;
      qlist.replaceChildren(
        h('div', { class: 'progress', style: 'margin-bottom:10px' }, h('i', { style: `width:${(answered / iv.items.length) * 100}%` })),
        h('div', { class: 'dim', style: 'font-size:12px;margin-bottom:8px' }, `${answered} of ${iv.items.length} answered`),
        h('div', { class: 'qlist' }, iv.items.map((it, i) => h('button', { class: i === cur ? 'active' : '', onclick: () => go(i) },
          h('span', { class: 'dot' + (it.follow_up ? ' fu' : it.response_text.trim() ? ' done' : '') }),
          h('span', null, `${it.position}. ${it.question_text.length > 46 ? it.question_text.slice(0, 46) + '...' : it.question_text}`)))),
        h('div', { class: 'legend' }, h('span', null, h('i', { style: 'background:var(--ok)' }), 'answered'), h('span', null, h('i', { style: 'background:var(--amber)' }), 'follow-up')));
    }

    // ------------------------------------------------------------- audio recording
    function audioPanel(it) {
      const box = h('div', { class: 'card', style: 'background:var(--panel2)' });
      const draw = () => {
        const rec = !!(recorder && recorder.state === 'recording');
        box.replaceChildren(
          h('div', { class: 'row sp' }, h('b', null, 'Audio recording (optional)'), h('span', { class: 'dim', style: 'font-size:12px' }, 'Microphone is used only while recording; the file is encrypted at rest.')),
          it.has_recording ? h('audio', { controls: true, src: `/api/interviews/${id}/items/${it.position}/recording?v=${Date.now()}`, style: 'width:100%;margin-top:8px' }) : null,
          !readOnly() ? h('div', { class: 'row', style: 'margin-top:8px' },
            h('button', { class: 'btn small' + (rec ? ' danger' : ''), onclick: rec ? () => recorder.stop() : startRec }, rec ? 'Stop & save recording' : it.has_recording ? 'Record again (replaces)' : 'Record answer'),
            it.has_recording && !rec ? h('button', { class: 'btn small', onclick: async () => { try { await api(`/api/interviews/${id}/items/${it.position}/recording`, { method: 'DELETE' }); it.has_recording = false; draw(); paintSummaryIfAny(); } catch (e) { fail(e); } } }, 'Delete recording') : null,
            rec ? badge('recording...', 'b-bad') : null) : (!it.has_recording ? h('p', { class: 'dim', style: 'margin:6px 0 0' }, 'No recording.') : null));
      };
      async function startRec() {
        if (!navigator.mediaDevices || !window.MediaRecorder) return toast('This browser cannot record audio here (needs localhost or HTTPS).', 'err');
        try {
          recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const chunks = [];
          recorder = new MediaRecorder(recStream);
          recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          recorder.onstop = async () => {
            recStream.getTracks().forEach((t) => t.stop());
            const blob = new Blob(chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] });
            recorder = null;
            try {
              const fd = new FormData();
              fd.append('file', blob, 'answer.webm');
              await api(`/api/interviews/${id}/items/${it.position}/recording`, { method: 'POST', form: fd });
              it.has_recording = true; toast('Recording saved', 'ok');
            } catch (e) { fail(e); }
            draw();
          };
          recorder.start(); draw();
        } catch (e) { fail(new Error('Microphone unavailable: ' + e.message)); }
      }
      draw();
      return box;
    }

    // ------------------------------------------------------------- question card
    function paintMain() {
      const it = iv.items[cur];
      const ro = readOnly();
      const resp = h('textarea', { rows: 6, placeholder: "Type the subject's response as given...", disabled: ro, oninput: (e) => { it.response_text = e.target.value; touch(); } }, it.response_text);
      const notes = h('textarea', { rows: 3, placeholder: 'Investigator note (your own observations or reminders)', disabled: ro, oninput: (e) => { it.notes = e.target.value; touch(); } }, it.notes);
      const fu = h('input', { type: 'checkbox', checked: !!it.follow_up, disabled: ro, onchange: (e) => { it.follow_up = e.target.checked ? 1 : 0; dirty = true; save(); } });
      main.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'row sp' }, h('span', { class: 'muted' }, `Question ${it.position} of ${iv.items.length}`), it.topic ? badge('topic: ' + it.topic, 'b-info') : null),
        h('div', { class: 'question-text' }, it.question_text),
        h('div', { class: 'grid', style: 'gap:12px' }, field(h('span', null, 'Recorded response ', App.sourceTag('measured')), resp), audioPanel(it),
          field(h('span', null, 'Investigator note ', App.sourceTag('human')), notes), h('label', { class: 'chk' }, fu, 'Mark this item for follow-up')),
        h('div', { class: 'row sp', style: 'margin-top:14px' },
          h('div', { class: 'row' }, h('button', { class: 'btn', disabled: cur === 0, onclick: () => go(cur - 1) }, 'Previous'),
            cur < iv.items.length - 1 ? h('button', { class: 'btn primary', onclick: () => go(cur + 1) }, ro ? 'Next' : 'Save & next') : null,
            !ro ? h('button', { class: 'btn', onclick: async () => { dirty = true; await save(); toast('Progress saved', 'ok'); } }, 'Save progress') : null, savedLbl),
          iv.status === 'in_progress' && can('investigator') ? h('button', { class: 'btn primary', onclick: complete }, 'Complete interview') : null,
          iv.status === 'completed' && can('investigator') ? h('button', { class: 'btn', onclick: async () => { try { await api(`/api/interviews/${id}/reopen`, { method: 'POST' }); iv = await api('/api/interviews/' + id); paintAll(); toast('Interview reopened', 'ok'); } catch (e) { fail(e); } } }, 'Reopen for editing') : null)));
      if (!ro) resp.focus();
    }

    async function complete() {
      await save();
      const unanswered = iv.items.filter((i) => !i.response_text.trim()).length;
      if (!(await confirmDialog(unanswered ? `${unanswered} question(s) have no response. Complete the interview anyway? You can reopen it later.` : 'Complete this interview and generate the structured summary?', 'Complete', 'primary'))) return;
      try {
        if (observer && observer.running) await stopObservation(true);
        await api(`/api/interviews/${id}/complete`, { method: 'POST' });
        iv = await api('/api/interviews/' + id);
        toast('Interview completed - summary generated', 'ok');
        paintAll();
        summaryBox.scrollIntoView({ behavior: 'smooth' });
      } catch (e) { fail(e); }
    }

    // ------------------------------------------------------------- summary
    function paintSummary() {
      if (!iv.summary) { summaryBox.replaceChildren(); return; }
      const s = iv.summary, byPos = Object.fromEntries(iv.items.map((i) => [i.position, i]));
      const diffs = s.differences_for_review || [];
      summaryBox.replaceChildren(h('div', { class: 'card', style: 'margin-top:16px' },
        h('div', { class: 'row sp' }, h('h2', { style: 'margin:0' }, 'Structured interview summary'), h('div', { class: 'row' },
          can('investigator') ? h('button', { class: 'btn small', onclick: async () => { try { await api(`/api/interviews/${id}/summary`, { method: 'POST' }); iv = await api('/api/interviews/' + id); paintSummary(); toast('Summary regenerated', 'ok'); } catch (e) { fail(e); } } }, 'Regenerate') : null,
          h('a', { class: 'btn small', href: `#/reports?case=${iv.case_id}` }, 'Case report'))),
        h('div', { class: 'chips', style: 'margin:10px 0' }, badge(`${s.answered}/${s.total_questions} answered`, 'b-info'), badge(`${s.follow_up_positions.length} follow-up`, s.follow_up_positions.length ? 'b-warn' : 'b-mut'),
          badge(`${(s.items_with_notes || []).length} with notes`, 'b-mut'), badge(`${(s.recordings || []).length} audio`, 'b-mut'), badge(`${diffs.length} difference(s) for review`, diffs.length ? 'b-warn' : 'b-mut')),
        s.unanswered_positions.length ? h('p', { class: 'muted' }, 'No response recorded for: Q' + s.unanswered_positions.join(', Q')) : null,
        s.follow_up_positions.length ? h('p', null, h('b', null, 'Marked for follow-up: '), s.follow_up_positions.map((p) => `Q${p}`).join(', ')) : null,
        h('h3', { style: 'margin-top:14px' }, 'Possible differences for human review ', App.sourceTag('model')),
        h('div', { class: 'notice info' }, 'These come from a simple keyword comparison of the recorded answers. Answers can differ because of wording, memory, clarification or misunderstanding. A difference is not evidence of deception.'),
        diffs.length ? diffs.map((d) => h('div', { class: 'card', style: 'margin-top:10px;background:var(--panel2)' },
          h('div', { class: 'row' }, badge(d.type, 'b-warn'), h('b', null, `Q${d.positions[0]} vs Q${d.positions[1]}`), h('span', { class: 'muted' }, d.detail)),
          h('div', { class: 'grid g2', style: 'margin-top:8px' }, d.positions.map((p) => h('div', null, h('div', { class: 'dim', style: 'font-size:12px' }, `Q${p}: ${byPos[p].question_text}`), h('div', null, highlight(byPos[p].response_text, d.shared_terms))))))) : h('p', { class: 'dim', style: 'margin-top:8px' }, 'No differences flagged.'),
        h('h3', { style: 'margin-top:14px' }, 'Full record'),
        h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['#', 'Question', 'Response', 'Note', 'Flags'].map((t) => h('th', null, t)))),
          h('tbody', null, iv.items.map((i) => h('tr', { class: 'click', onclick: () => go(i.position - 1).then(() => window.scrollTo(0, 0)) },
            h('td', null, i.position), h('td', null, i.question_text), h('td', null, i.response_text || h('span', { class: 'dim' }, '(none)')), h('td', null, i.notes),
            h('td', null, i.follow_up ? badge('follow-up', 'b-warn') : null, ' ', i.has_recording ? badge('audio', 'b-info') : null))))))));
    }
    const paintSummaryIfAny = () => { if (iv.summary) paintSummary(); };

    // ------------------------------------------------------------- optional webcam observation
    let obsCtl = null;
    function paintObservation() {
      if (readOnly()) { obsHost.replaceChildren(); return; }
      const consent = h('input', { type: 'checkbox', name: 'consent' });
      const view = ObserverUI.view({ compact: true });
      const st = h('div', { class: 'dim', style: 'font-size:12px;margin-top:6px' });
      const startBtn = h('button', { class: 'btn small primary' }, 'Start observation');
      const stopBtn = h('button', { class: 'btn small', disabled: true }, 'Stop & save');
      obsCtl = { startBtn, stopBtn, st, view };
      startBtn.onclick = async () => {
        if (!consent.checked) return toast("Confirm the subject's consent to webcam observation first", 'err');
        startBtn.disabled = true; st.textContent = 'Loading face model and camera...';
        try {
          let last = 0;
          observer = new ObserverUI.Observer({ video: view.video, canvas: view.canvas, onUpdate: (L) => { const n = performance.now(); if (n - last > 250) { last = n; view.update(L); } }, onEnded: () => stopObservation(true) });
          view.bindToggles(observer);
          await observer.start({ source: 'webcam' });
          observer.mark(`Question ${iv.items[cur].position} shown`);
          stopBtn.disabled = false; st.textContent = 'Observing. Video stays in this browser; only measurements are saved.';
        } catch (e) { fail(e); startBtn.disabled = false; st.textContent = ''; observer = null; }
      };
      stopBtn.onclick = () => stopObservation(true);
      obsHost.replaceChildren(h('div', { class: 'card' }, h('h3', null, 'Visual observation (optional)'),
        h('div', { class: 'notice warn', style: 'margin-bottom:8px' }, 'Measures visible head, eye and landmark movement only. It cannot show whether anyone is truthful, nervous or lying.'),
        h('label', { class: 'chk' }, consent, 'The subject consents to webcam observation for this interview.'), view.el, h('div', { class: 'row', style: 'margin-top:8px' }, startBtn, stopBtn), st));
    }
    async function stopObservation(saveIt) {
      if (!observer) return;
      const r = observer.stop();
      observer = null;
      if (obsCtl) { obsCtl.startBtn.disabled = false; obsCtl.stopBtn.disabled = true; obsCtl.st.textContent = ''; obsCtl.view.showPlaceholder(); }
      if (saveIt && r && r.series.t.length > 5) {
        try {
          const o = await api('/api/observations', { method: 'POST', json: { case_id: iv.case_id, interview_id: +id, consent_confirmed: true, is_demo: !!iv.is_demo, ...r } });
          toast(`Observation saved (#${o.id}) - view it from the case's Observations tab`, 'ok');
        } catch (e) { fail(e); }
      }
    }

    function paintAll() { paintMain(); paintList(); paintSummary(); paintObservation(); }
    root.append(h('div', { class: 'row sp' }, h('div', null,
      h('div', { class: 'row' }, h('h1', { style: 'margin:0' }, `Interview #${id}`), badge(iv.status.replace('_', ' '), iv.status === 'completed' ? 'b-ok' : 'b-warn'), demoBadge(iv.is_demo)),
      h('p', { class: 'sub', style: 'margin-top:4px' }, 'Subject ', h('b', null, iv.subject_ref), ' - case ', h('a', { href: '#/cases/' + c.id + '?tab=Interviews' }, c.case_number), ` - consent: ${iv.consent_note || 'recorded'}`)),
      h('a', { class: 'btn', href: '#/interviews' }, 'All interviews')),
      !can('investigator') ? h('div', { class: 'notice info', style: 'margin-bottom:12px' }, 'Read-only view (viewer role).') : null,
      h('div', { class: 'grid g-main' }, h('div', null, main, summaryBox),
        h('div', null, h('div', { class: 'card' }, h('h3', null, 'Questions'), qlist), h('div', { style: 'margin-top:16px' }, obsHost))));
    paintAll();

    return () => { // cleanup when leaving the page
      clearTimeout(timer);
      if (dirty && !readOnly()) {
        const it = iv.items[cur];
        fetch(`/api/interviews/${id}/items/${it.position}`, { method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ response_text: it.response_text, notes: it.notes, follow_up: !!it.follow_up }) });
      }
      if (observer) { observer.stop(); observer = null; }
      if (recorder && recorder.state === 'recording') { recorder.onstop = null; recorder.stop(); }
      if (recStream) recStream.getTracks().forEach((t) => t.stop());
    };
  };
})();
