(function () {
  const { h, api, fmtTime, badge, can, empty } = App;

  App.pages.dashboard = async (root) => {
    const [a, vis] = await Promise.all([api('/api/analytics'), api('/api/vision/status')]);
    const kpi = (n, l, href, accent) => h('a', { class: 'card kpi' + (accent ? ' accent' : ''), href, style: 'display:block;color:inherit;text-decoration:none' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
    const open = a.open_items;
    const attention = open.follow_ups.length + open.interviews_in_progress.length + open.matches_awaiting_review.length;
    const statusData = Object.keys(App.STATUS).map((k, i) => ({ label: App.STATUS[k], value: a.cases_by_status[k] || 0, color: Charts.COL[i] })).filter((d) => d.value);

    root.append(
      h('h1', null, 'Dashboard'), h('p', { class: 'sub' }, 'Overview of cases, evidence, analyses and items waiting for human review.'),
      h('div', { class: 'row', style: 'margin-bottom:16px' },
        can('investigator') ? h('a', { class: 'btn primary', href: '#/cases?new=1' }, '+ New case') : null,
        h('a', { class: 'btn', href: '#/analysis' }, 'Analyse image / video'),
        can('investigator') ? h('a', { class: 'btn', href: '#/interviews?new=1' }, 'Start interview') : null,
        h('a', { class: 'btn', href: '#/observe' }, 'Observation lab')),
      h('div', { class: 'grid g4' },
        kpi(a.cases_total, `cases (${a.demo_cases} demonstration)`, '#/cases', true), kpi(a.evidence_total, 'evidence items', '#/evidence'),
        kpi(a.analyses_total, 'face-detection runs', '#/analysis'), kpi(attention, 'items need attention', '#/activity')),
      h('div', { class: 'grid g-main', style: 'margin-top:16px' },
        h('div', null,
          h('div', { class: 'card' }, h('h3', null, 'Activity, last 14 days'), Charts.bars(a.activity_by_day.map((d) => ({ label: d.day.slice(5), value: d.n })))),
          h('div', { class: 'card' }, h('h3', null, 'Recent activity'),
            a.recent_events.length ? a.recent_events.map((e) => h('div', { class: 'list-item' },
              h('div', null, h('b', null, e.type.replace(/_/g, ' ')), ' ', h('span', { class: 'muted' }, e.detail)),
              h('div', { class: 'dim', style: 'white-space:nowrap;font-size:12px' }, `${e.username} - ${fmtTime(e.ts)}`))) : empty('No activity yet'),
            h('div', { style: 'margin-top:10px' }, h('a', { href: '#/activity' }, 'Open full activity log')))),
        h('div', null,
          h('div', { class: 'card' }, h('h3', null, 'Cases by status'), statusData.length ? Charts.donut(statusData) : empty('No cases')),
          h('div', { class: 'card' }, h('h3', null, 'Needs attention'),
            attention ? [
              open.matches_awaiting_review.map((m) => h('div', { class: 'list-item' }, h('span', null, `Candidate "${m.reference_label}" (score ${m.score.toFixed(2)}) awaits human review`), h('a', { href: '#/analysis/' + m.analysis_id }, 'Review'))),
              open.follow_ups.map((f) => h('div', { class: 'list-item' }, h('span', null, `${f.case_number} Q${f.position}: ${f.question_text}`), h('a', { href: `#/interview/${f.interview_id}?q=${f.position}` }, 'Open'))),
              open.interviews_in_progress.map((i) => h('div', { class: 'list-item' }, h('span', null, `Interview #${i.id} (${i.subject_ref}) in progress - ${i.case_number}`), h('a', { href: '#/interview/' + i.id }, 'Resume')))] : empty('Nothing waiting')),
          h('div', { class: 'card' }, h('h3', null, 'Evidence by type'), Object.keys(a.evidence_by_kind).length ? Charts.hbars(Object.entries(a.evidence_by_kind).map(([label, value]) => ({ label, value }))) : empty('No evidence')),
          h('div', { class: 'card' }, h('h3', null, 'Vision engine'),
            h('div', { class: 'chips' }, badge(vis.detector, vis.detector_has_landmarks ? 'b-ok' : 'b-warn'), badge(vis.matching_available ? 'matching available' : 'matching not installed', vis.matching_available ? 'b-ok' : 'b-mut')),
            vis.hint ? h('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, vis.hint) : null,
            h('p', { class: 'dim', style: 'font-size:12px;margin-top:8px' }, 'Detection finds faces; it does not identify people.')))));
  };
})();
