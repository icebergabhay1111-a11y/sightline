/* Shell: login, sidebar, hash router. */
(function () {
  const { h, api, icon } = App;
  const NAV = [
    ['Workspace', [['dashboard', 'Dashboard', 'dashboard'], ['cases', 'Cases', 'cases']]],
    ['Analysis', [['analysis', 'Face analysis', 'faces'], ['references', 'References', 'refs'], ['interviews', 'Interviews', 'interviews'], ['observe', 'Observation lab', 'observe']]],
    ['Records', [['evidence', 'Evidence', 'evidence'], ['reports', 'Reports & analytics', 'reports'], ['activity', 'Activity log', 'activity']]],
    ['System', [['settings', 'Settings', 'settings']]],
  ];
  // route -> [page function name, nav item to highlight]
  const ROUTES = {
    dashboard: ['dashboard', 'dashboard'], cases: ['cases', 'cases'], analysis: ['analysis', 'analysis'], references: ['references', 'references'],
    interviews: ['interviews', 'interviews'], interview: ['interviewRun', 'interviews'], observe: ['observe', 'observe'], observation: ['observationView', 'observe'], gaze: ['gazeView', 'observe'],
    evidence: ['evidence', 'evidence'], reports: ['reports', 'reports'], activity: ['activity', 'activity'], settings: ['settings', 'settings'],
  };
  const $ = (id) => document.getElementById(id);

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
    const [path, query = ''] = raw.split('?');
    const q = {};
    query.split('&').filter(Boolean).forEach((p) => { const [k, v] = p.split('='); q[decodeURIComponent(k)] = decodeURIComponent(v || ''); });
    return { parts: path.split('/').filter(Boolean), query: q };
  }

  function runCleanup() {
    if (App.cleanup) { try { App.cleanup(); } catch (e) { console.error(e); } App.cleanup = null; }
  }

  function showLogin() {
    runCleanup();
    App.user = null;
    document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
    $('app').classList.add('hidden');
    const v = $('login-view');
    v.classList.remove('hidden');
    const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', placeholder: 'username', required: true });
    const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'password', required: true });
    const msg = h('div', { class: 'notice bad hidden', style: 'margin-top:10px' });
    const submit = async (ev) => {
      ev.preventDefault();
      msg.classList.add('hidden');
      try {
        App.user = await api('/api/auth/login', { method: 'POST', json: { username: user.value.trim(), password: pass.value }, quiet401: true });
        await start();
      } catch (e) { msg.textContent = e.message; msg.classList.remove('hidden'); }
    };
    v.replaceChildren(h('form', { class: 'card login-card', onsubmit: submit },
      h('div', { class: 'brand', style: 'padding-bottom:6px' }, icon('observe'), h('div', null, 'SIGHTLINE', h('small', null, 'AI-assisted investigation workbench'))),
      h('p', { class: 'muted' }, 'Academic prototype for a multidisciplinary college project: face detection, optional consented reference matching, structured interviews, visible-movement measurement, and case/evidence management.'),
      h('div', { class: 'grid', style: 'gap:10px;margin-top:14px' }, App.field('Username', user), App.field('Password', pass)),
      msg,
      h('button', { class: 'btn primary', type: 'submit', style: 'width:100%;margin-top:14px' }, 'Sign in'),
      h('p', { class: 'dim', style: 'font-size:12px;margin-top:14px' }, 'Demo accounts: admin, investigator, viewer. The password is printed in the terminal on first start (default Demo@1234). Not validated for real investigations.')));
    user.focus();
  }
  App.showLogin = showLogin;

  function buildShell() {
    $('sidebar').replaceChildren(h('div', { class: 'brand' }, icon('observe'), h('div', null, 'SIGHTLINE', h('small', null, 'investigation workbench'))),
      NAV.map(([group, items]) => [h('div', { class: 'nav-group' }, group),
        h('nav', { class: 'nav' }, items.map(([key, label, ic]) => h('a', { href: '#/' + key, 'data-nav': key }, icon(ic), label)))]));
    $('topbar').replaceChildren(
      h('div', { class: 'grow' }),
      h('span', { class: 'muted' }, App.user.username), App.badge(App.user.role, 'b-info'),
      h('button', { class: 'btn small', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); history.replaceState(null, '', '#/dashboard'); showLogin(); } }, 'Sign out'));
  }

  async function route() {
    if (!App.user) return;
    runCleanup();
    document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
    const ctx = parseHash();
    let [name, nav] = ROUTES[ctx.parts[0]] || ROUTES.dashboard;
    if (ctx.parts[0] === 'cases' && ctx.parts[1]) name = 'caseDetail';
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
    const page = $('page');
    const root = h('div');
    page.replaceChildren(h('div', { class: 'splash' }, 'Loading...'));
    window.scrollTo(0, 0);
    try {
      const cleanup = await App.pages[name](root, ctx);
      page.replaceChildren(root);
      if (typeof cleanup === 'function') App.cleanup = cleanup;
    } catch (e) {
      if (e.message !== 'Please sign in') { console.error(e); page.replaceChildren(h('div', { class: 'notice bad' }, 'Could not load this page: ' + e.message)); }
    }
  }
  App.route = route;

  async function start() {
    $('login-view').classList.add('hidden');
    $('app').classList.remove('hidden');
    App.meta = await api('/api/meta').catch(() => null);
    buildShell();
    if (!location.hash) history.replaceState(null, '', '#/dashboard');
    route();
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', runCleanup);
  (async () => {
    try { App.user = await api('/api/auth/me', { quiet401: true }); await start(); } catch (e) { showLogin(); }
  })();
})();
