(function () {
  const { h, api, fmtTime, badge, statusBadge, prioBadge, demoBadge, can, empty, field, modal, confirmDialog, toast, fail, STATUS } = App;

  function caseForm(c) {
    const f = {
      title: h('input', { type: 'text', value: c ? c.title : '', maxLength: 160, placeholder: 'Short descriptive title' }),
      description: h('textarea', { rows: 5, placeholder: 'Fictional scenario or case notes' }, c ? c.description : ''),
      status: h('select', null, Object.entries(STATUS).map(([k, v]) => h('option', { value: k, selected: c && c.status === k }, v))),
      priority: h('select', null, ['low', 'medium', 'high'].map((p) => h('option', { value: p, selected: (c ? c.priority : 'medium') === p }, p))),
      is_demo: h('input', { type: 'checkbox', checked: c ? !!c.is_demo : true }),
    };
    const el = h('div', { class: 'grid' }, field('Title', f.title), field('Description', f.description),
      h('div', { class: 'form-grid' }, field('Status', f.status), field('Priority', f.priority)),
      h('label', { class: 'chk' }, f.is_demo, 'This is fictional / demonstration data'));
    const val = () => ({ title: f.title.value.trim(), description: f.description.value, status: f.status.value, priority: f.priority.value, is_demo: f.is_demo.checked });
    return { el, val, focus: () => f.title.focus() };
  }

  function openCaseModal(c, done) {
    const form = caseForm(c);
    modal({ title: c ? `Edit ${c.case_number}` : 'New case', body: form.el, actions: [{ label: 'Cancel' }, { label: c ? 'Save changes' : 'Create case', kind: 'primary', onClick: async () => {
      const v = form.val();
      if (v.title.length < 3) { toast('Title needs at least 3 characters', 'err'); return false; }
      if (c) { await api('/api/cases/' + c.id, { method: 'PATCH', json: v }); toast('Case updated', 'ok'); }
      else { const r = await api('/api/cases', { method: 'POST', json: v }); toast('Created ' + r.case_number, 'ok'); }
      done && done();
    } }] });
    form.focus();
  }
  App.openCaseModal = openCaseModal;

  App.pages.cases = async (root, ctx) => {
    const state = { q: '', status: '', priority: '', demo: '', sort: 'updated' };
    const body = h('div');
    const load = async () => {
      const rows = await api('/api/cases?' + App.qs(state));
      body.replaceChildren(rows.length ? h('div', { class: 'card tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Case', 'Title', 'Status', 'Priority', 'Evidence', 'Analyses', 'Interviews', 'Observations', 'Updated'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((c) => h('tr', { class: 'click', onclick: () => (location.hash = '#/cases/' + c.id) },
          h('td', null, h('b', null, c.case_number), ' ', demoBadge(c.is_demo)), h('td', null, c.title), h('td', null, statusBadge(c.status)), h('td', null, prioBadge(c.priority)),
          h('td', null, c.evidence_count), h('td', null, c.analyses_count), h('td', null, c.interviews_count), h('td', null, c.observations_count), h('td', { class: 'dim' }, fmtTime(c.updated_at))))))) : empty('No cases match these filters.'));
    };
    const reload = () => load().catch(fail);
    const sel = (key, label, opts) => h('select', { 'aria-label': label, onchange: (e) => { state[key] = e.target.value; reload(); } }, h('option', { value: '' }, label), opts.map(([v, t]) => h('option', { value: v }, t)));
    root.append(h('div', { class: 'row sp' }, h('div', null, h('h1', null, 'Cases'), h('p', { class: 'sub' }, 'Create, search and manage investigation case records. Demonstration cases are fictional.')),
      can('investigator') ? h('button', { class: 'btn primary', onclick: () => openCaseModal(null, reload) }, '+ New case') : null),
      h('div', { class: 'toolbar' },
        h('input', { type: 'search', placeholder: 'Search number, title, description...', style: 'min-width:260px', oninput: App.debounce((e) => { state.q = e.target.value; reload(); }) }),
        sel('status', 'All statuses', Object.entries(STATUS)), sel('priority', 'All priorities', [['low', 'low'], ['medium', 'medium'], ['high', 'high']]),
        sel('demo', 'Demo + other', [['1', 'Demonstration only'], ['0', 'Not demonstration']]),
        h('select', { 'aria-label': 'Sort', onchange: (e) => { state.sort = e.target.value; reload(); } }, [['updated', 'Sort: recently updated'], ['created', 'Sort: newest'], ['number', 'Sort: case number'], ['title', 'Sort: title']].map(([v, t]) => h('option', { value: v }, t)))),
      body);
    await load();
    if (ctx.query.new && can('investigator')) { history.replaceState(null, '', '#/cases'); setTimeout(() => openCaseModal(null, reload), 0); }
  };

  App.pages.caseDetail = async (root, ctx) => {
    const id = ctx.parts[1];
    const c = await api('/api/cases/' + id);
    const tabs = ['Overview', 'Evidence', 'Analyses', 'Interviews', 'Observations', 'Timeline'];
    let tab = tabs.includes(ctx.query.tab) ? ctx.query.tab : 'Overview';
    const pane = h('div');
    const tabBar = h('div', { class: 'tabs', role: 'tablist' });
    const go = (t) => { tab = t; draw(); };
    const draw = async () => {
      tabBar.replaceChildren(tabs.map((t) => h('button', { class: t === tab ? 'active' : '', role: 'tab', onclick: () => go(t) }, t)));
      pane.replaceChildren(h('div', { class: 'splash', style: 'height:120px' }, 'Loading...'));
      try { pane.replaceChildren(await panes[tab]()); } catch (e) { pane.replaceChildren(h('div', { class: 'notice bad' }, e.message)); }
    };
    const tbl = (head, rows) => h('div', { class: 'card tablewrap' }, h('table', null, h('thead', null, h('tr', null, head.map((t) => h('th', null, t)))), h('tbody', null, rows)));
    const panes = {
      Overview: async () => h('div', { class: 'grid g-main' },
        h('div', { class: 'card' }, h('h3', null, 'Description'), h('p', { style: 'white-space:pre-wrap' }, c.description || '-'),
          h('p', { class: 'dim' }, `Created ${fmtTime(c.created_at)} by ${c.created_by_name || '-'}; last updated ${fmtTime(c.updated_at)}.`)),
        h('div', { class: 'card' }, h('h3', null, 'Contents'), [['Evidence', c.evidence_count, 'Evidence'], ['Face analyses', c.analyses_count, 'Analyses'], ['Interviews', c.interviews_count, 'Interviews'], ['Observations', c.observations_count, 'Observations'], ['Gaze sessions', c.gaze_count || 0, 'Observations']]
          .map(([l, n, t]) => h('div', { class: 'list-item' }, h('span', null, l), h('button', { class: 'btn small', onclick: () => go(t) }, `${n} - view`))))),
      Evidence: async () => {
        const ev = await api('/api/evidence?case_id=' + id);
        return h('div', null, can('investigator') ? App.evidenceUploader(id, () => draw()) : null, ev.length ? App.evidenceTable(ev, () => draw()) : empty('No evidence uploaded for this case.'));
      },
      Analyses: async () => {
        const an = await api('/api/analyses?case_id=' + id);
        return h('div', null, can('investigator') ? h('div', { class: 'row', style: 'margin-bottom:10px' }, h('a', { class: 'btn primary', href: '#/analysis?case=' + id }, 'Run face detection')) : null,
          an.length ? tbl(['#', 'Evidence', 'Type', 'Detector', 'Max faces', 'Run'], an.map((a) => h('tr', { class: 'click', onclick: () => (location.hash = '#/analysis/' + a.id) },
            h('td', null, a.id), h('td', null, a.original_name), h('td', null, a.kind), h('td', null, a.detector), h('td', null, a.face_count_max), h('td', { class: 'dim' }, fmtTime(a.created_at))))) : empty('No detection runs yet.'));
      },
      Interviews: async () => {
        const iv = await api('/api/interviews?case_id=' + id);
        return h('div', null, can('investigator') ? h('div', { style: 'margin-bottom:10px' }, h('a', { class: 'btn primary', href: `#/interviews?new=1&case=${id}` }, 'New interview')) : null,
          iv.length ? tbl(['#', 'Subject ref', 'Status', 'Answered', 'Follow-ups', 'Updated'], iv.map((i) => h('tr', { class: 'click', onclick: () => (location.hash = '#/interview/' + i.id) },
            h('td', null, i.id), h('td', null, i.subject_ref, ' ', demoBadge(i.is_demo)), h('td', null, badge(i.status.replace('_', ' '), i.status === 'completed' ? 'b-ok' : 'b-warn')),
            h('td', null, `${i.answered}/${i.total}`), h('td', null, i.follow_ups), h('td', { class: 'dim' }, fmtTime(i.updated_at))))) : empty('No interviews yet.'));
      },
      Observations: async () => {
        const ob = await api('/api/observations?case_id=' + id);
        const gz = App.meta && App.meta.gaze_enabled === false ? null : await App.gazeSessionList({ case_id: id });
        return h('div', null, h('div', { style: 'margin-bottom:10px' }, h('a', { class: 'btn primary', href: '#/observe?case=' + id }, 'Open observation lab')),
          gz ? h('h3', null, 'Facial-movement observations') : null,
          ob.length ? tbl(['#', 'Source', 'Duration', 'Tracked', 'Blink events', 'Saved'], ob.map((o) => h('tr', { class: 'click', onclick: () => (location.hash = '#/observation/' + o.id) },
            h('td', null, o.id), h('td', null, `${o.source} ${o.source_name || ''}`, ' ', demoBadge(o.is_demo)), h('td', null, o.duration_s.toFixed(0) + ' s'),
            h('td', null, Math.round((o.summary.tracked_fraction || 0) * 100) + '%'), h('td', null, o.summary.blink_count), h('td', { class: 'dim' }, fmtTime(o.created_at))))) : empty('No observations recorded.'),
          gz ? h('h3', { style: 'margin-top:18px' }, 'Gaze observation sessions') : null, gz);
      },
      Timeline: async () => {
        const ev = await api(`/api/cases/${id}/timeline`);
        return ev.length ? h('div', { class: 'card' }, ev.map((e) => h('div', { class: 'list-item' }, h('div', null, h('b', null, e.type.replace(/_/g, ' ')), ' ', h('span', { class: 'muted' }, e.detail)),
          h('div', { class: 'dim', style: 'font-size:12px;white-space:nowrap' }, `${e.username} - ${fmtTime(e.ts)}`)))) : empty('No events.');
      },
    };
    root.append(
      h('div', { class: 'row sp' },
        h('div', null, h('div', { class: 'row' }, h('h1', { style: 'margin:0' }, c.case_number), statusBadge(c.status), prioBadge(c.priority), demoBadge(c.is_demo)), h('p', { class: 'sub', style: 'margin-top:4px' }, c.title)),
        h('div', { class: 'row' },
          can('investigator') ? h('button', { class: 'btn', onclick: () => openCaseModal(c, () => App.route()) }, 'Edit') : null,
          h('a', { class: 'btn', href: `#/reports?case=${id}` }, 'Report'),
          h('button', { class: 'btn', onclick: () => App.download(`/api/cases/${id}/export.json`) }, 'Export JSON'),
          can('admin') ? h('button', { class: 'btn danger', onclick: async () => {
            if (!(await confirmDialog(`Delete ${c.case_number} and all of its evidence, analyses, interviews and observations? This cannot be undone.`, 'Delete case'))) return;
            try { await api('/api/cases/' + id, { method: 'DELETE' }); toast('Case deleted', 'ok'); location.hash = '#/cases'; } catch (e) { fail(e); }
          } }, 'Delete') : null)),
      tabBar, pane);
    await draw();
  };
})();
