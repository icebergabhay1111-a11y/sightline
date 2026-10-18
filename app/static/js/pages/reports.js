(function () {
  const { h, api, fmtTime, badge, empty, field, fail, toast } = App;
  const SECTIONS = [
    ['case', 'Case summary and status', 'human'], ['interviews', 'Interview questions, recorded responses and flagged differences', 'measured'],
    ['faces', 'Face-detection results and image-quality flags', 'model'], ['matches', 'Optional reference matching, scores and human decisions', 'model'],
    ['observations', 'Visual-observation timelines and measurements', 'measured'], ['evidence', 'Evidence inventory with SHA-256 hashes', 'measured'],
    ['notes', 'Reviewer notes and unresolved items', 'human'], ['software', 'Model and software details', 'measured'],
  ];

  App.pages.reports = async (root, ctx) => {
    const { options } = await App.caseOptions(ctx.query.case || '');
    const caseSel = h('select', null, h('option', { value: '' }, 'Choose a case...'), options);
    const checks = Object.fromEntries(SECTIONS.map(([k]) => [k, h('input', { type: 'checkbox', checked: true })]));
    const preview = h('div'), out = h('div'), analyticsBox = h('div');

    async function drawPreview() {
      out.replaceChildren();
      if (!caseSel.value) { preview.replaceChildren(empty('Choose a case to prepare its report.')); return; }
      const c = await api('/api/cases/' + caseSel.value);
      preview.replaceChildren(h('div', { class: 'chips' }, badge(c.case_number, 'b-info'), badge(`${c.evidence_count} evidence`, 'b-mut'), badge(`${c.analyses_count} detection run(s)`, 'b-mut'),
        badge(`${c.interviews_count} interview(s)`, 'b-mut'), badge(`${c.observations_count} observation(s)`, 'b-mut'), c.is_demo ? badge('DEMO DATA', 'b-demo') : null));
    }
    caseSel.onchange = () => drawPreview().catch(fail);

    const generate = async (ev) => {
      if (!caseSel.value) return toast('Choose a case first', 'err');
      const sel = SECTIONS.map(([k]) => k).filter((k) => checks[k].checked);
      if (!sel.length) return toast('Select at least one section', 'err');
      const b = ev.currentTarget; b.disabled = true; b.textContent = 'Generating...';
      try {
        const r = await api(`/api/cases/${caseSel.value}/report.pdf?sections=${sel.join(',')}`);
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const name = `case-${caseSel.value}-report.pdf`;
        App.download(url);
        const a = h('a', { href: url, download: name }, 'download it again');
        const o = h('a', { href: url, target: '_blank', rel: 'noopener' }, 'open it in a new tab');
        out.replaceChildren(h('div', { class: 'notice info', style: 'margin-top:12px' }, `Report ready (${(blob.size / 1024).toFixed(0)} KB, ${sel.length} section(s)). If the download did not start, `, a, ' or ', o, '.'));
      } catch (e) { fail(e); } finally { b.disabled = false; b.textContent = 'Generate PDF report'; }
    };

    root.append(h('h1', null, 'Reports & analytics'), h('p', { class: 'sub' }, 'Generate a PDF case report that separates observed facts, model-generated outputs and human-entered conclusions.'),
      h('div', { class: 'grid g-main' },
        h('div', { class: 'card' }, h('h3', null, 'Case report'), field('Case', caseSel), h('div', { style: 'margin:10px 0' }, preview),
          h('div', { class: 'row sp', style: 'margin-top:14px' }, h('h3', { style: 'margin:0' }, 'Sections to include'),
            h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => Object.values(checks).forEach((c) => (c.checked = true)) }, 'All'), h('button', { class: 'btn small', onclick: () => Object.values(checks).forEach((c) => (c.checked = false)) }, 'None'))),
          h('div', { class: 'grid', style: 'gap:8px;margin-top:8px' }, SECTIONS.map(([k, label, kind]) => h('label', { class: 'chk' }, checks[k], h('span', null, label, ' ', App.sourceTag(kind))))),
          h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn primary', onclick: generate }, 'Generate PDF report'),
            h('button', { class: 'btn', onclick: () => { if (!caseSel.value) return toast('Choose a case first', 'err'); App.download(`/api/cases/${caseSel.value}/export.json`); } }, 'Export case summary (JSON)')), out),
        h('div', { class: 'card' }, h('h3', null, 'How to read the report'),
          [['measured', 'Raw records and measurements: timestamps, hashes, entered answers, tracked values.'], ['model', 'Produced by an algorithm. Uncertain; false matches and misses occur.'], ['human', 'Notes, decisions and conclusions typed by a person.']]
            .map(([k, t]) => h('div', { class: 'list-item' }, h('div', { style: 'min-width:150px' }, App.sourceTag(k)), h('div', { class: 'muted' }, t))),
          h('div', { class: 'notice warn', style: 'margin-top:12px' }, 'Every report carries a banner stating it is an academic prototype that is not validated for real investigations.'))),
      h('h2', { style: 'margin-top:28px' }, 'Analytics'), analyticsBox);

    const a = await api('/api/analytics');
    const st = Object.keys(App.STATUS).map((k, i) => ({ label: App.STATUS[k], value: a.cases_by_status[k] || 0, color: Charts.COL[i] })).filter((d) => d.value);
    analyticsBox.append(
      h('div', { class: 'grid g4' }, [['Cases', a.cases_total], ['Evidence items', a.evidence_total], ['Detection runs', a.analyses_total], ['Observations', a.observations_total]].map(([l, n]) => h('div', { class: 'card kpi' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l)))),
      h('div', { class: 'grid g3', style: 'margin-top:16px' },
        h('div', { class: 'card' }, h('h3', null, 'Cases by status'), st.length ? Charts.donut(st) : empty('No cases')),
        h('div', { class: 'card' }, h('h3', null, 'Evidence by type'), Object.keys(a.evidence_by_kind).length ? Charts.hbars(Object.entries(a.evidence_by_kind).map(([label, value]) => ({ label, value }))) : empty('No evidence')),
        h('div', { class: 'card' }, h('h3', null, 'Interviews'), Object.keys(a.interviews_by_status).length ? Charts.hbars(Object.entries(a.interviews_by_status).map(([label, value]) => ({ label: label.replace('_', ' '), value }))) : empty('No interviews'))),
      h('div', { class: 'card', style: 'margin-top:16px' }, h('h3', null, 'Activity, last 14 days'), Charts.bars(a.activity_by_day.map((d) => ({ label: d.day.slice(5), value: d.n })))));
    await drawPreview();
  };

  App.pages.activity = async (root) => {
    const state = { case_id: '', type: '', username: '', q: '', offset: 0, limit: 50 };
    const { options } = await App.caseOptions('', true);
    const typeSel = h('select', { 'aria-label': 'Event type' }), userSel = h('select', { 'aria-label': 'User' }), list = h('div'), pager = h('div', { class: 'row', style: 'margin-top:10px' });
    let metaLoaded = false;
    async function load() {
      const d = await api('/api/events?' + App.qs(state));
      if (!metaLoaded) {
        typeSel.append(h('option', { value: '' }, 'All event types'), d.types.map((t) => h('option', { value: t }, t.replace(/_/g, ' '))));
        userSel.append(h('option', { value: '' }, 'All users'), d.users.map((u) => h('option', { value: u }, u)));
        metaLoaded = true;
      }
      list.replaceChildren(d.items.length ? h('div', { class: 'card tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Time', 'User', 'Event', 'Case', 'Detail'].map((t) => h('th', null, t)))),
        h('tbody', null, d.items.map((e) => h('tr', null, h('td', { class: 'dim', style: 'white-space:nowrap' }, fmtTime(e.ts)), h('td', null, e.username), h('td', null, badge(e.type.replace(/_/g, ' '), 'b-info')),
          h('td', null, e.case_id ? h('a', { href: '#/cases/' + e.case_id }, e.case_number || String(e.case_id)) : '-'), h('td', { class: 'muted' }, e.detail)))))) : empty('No events match.'));
      pager.replaceChildren(h('button', { class: 'btn small', disabled: state.offset === 0, onclick: () => { state.offset = Math.max(0, state.offset - state.limit); load().catch(fail); } }, 'Newer'),
        h('span', { class: 'dim' }, d.total ? `${state.offset + 1}-${Math.min(state.offset + state.limit, d.total)} of ${d.total}` : '0 events'),
        h('button', { class: 'btn small', disabled: state.offset + state.limit >= d.total, onclick: () => { state.offset += state.limit; load().catch(fail); } }, 'Older'));
    }
    const set = (key) => (e) => { state[key] = e.target.value; state.offset = 0; load().catch(fail); };
    typeSel.onchange = set('type'); userSel.onchange = set('username');
    root.append(h('h1', null, 'Activity log'), h('p', { class: 'sub' }, 'Every sign-in, upload, analysis, review decision and export is recorded with user and time.'),
      h('div', { class: 'toolbar' }, h('select', { 'aria-label': 'Case', onchange: set('case_id') }, options), typeSel, userSel,
        h('input', { type: 'search', placeholder: 'Search detail...', oninput: App.debounce(set('q')) })), list, pager);
    await load();
  };
})();
