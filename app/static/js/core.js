/* Sightline core helpers: DOM builder, API wrapper, toasts, modals, formatting.
   User data is only ever inserted as text nodes, never through innerHTML. */
(function () {
  const App = (window.App = { user: null, meta: null, pages: {}, cleanup: null });

  // append / prepend / replaceChildren accept nested arrays and skip null/false, so list rendering is uniform.
  ['append', 'prepend', 'replaceChildren'].forEach((name) => {
    const orig = Element.prototype[name];
    Element.prototype[name] = function (...kids) {
      const flat = [];
      (function walk(a) { a.forEach((x) => { if (Array.isArray(x)) walk(x); else if (x != null && x !== false) flat.push(x instanceof Node ? x : document.createTextNode(String(x))); }); })(kids);
      return orig.apply(this, flat);
    };
  });

  function add(el, k) {
    if (k == null || k === false) return;
    if (Array.isArray(k)) k.forEach((x) => add(el, x));
    else if (k instanceof Node) el.appendChild(k);
    else el.appendChild(document.createTextNode(String(k)));
  }
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k in el) { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    kids.forEach((k) => add(el, k));
    return el;
  }
  const NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    kids.forEach((k) => add(el, k));
    return el;
  }
  const ICONS = {
    dashboard: 'M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z',
    cases: 'M3 7h18v13H3zM8 7V4h8v3',
    faces: 'M12 3a9 9 0 100 18 9 9 0 000-18zM8.5 10h.01M15.5 10h.01M8.5 15c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8',
    refs: 'M4 5h16v14H4zM8 10a2 2 0 104 0 2 2 0 00-4 0M6 17c.6-2 2-3 4-3s3.4 1 4 3M15 9h3M15 13h3',
    interviews: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
    observe: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6',
    evidence: 'M14 3H6v18h12V7zM14 3v4h4M9 12h6M9 16h6',
    reports: 'M5 3h10l4 4v14H5zM9 12h6M9 16h6M9 8h3',
    activity: 'M3 12h4l3-8 4 16 3-8h4',
    settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
  };
  function icon(name) {
    return svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
      svg('path', { d: ICONS[name] || ICONS.cases }));
  }

  async function api(path, o = {}) {
    const opts = { method: o.method || 'GET', headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
    if (o.json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(o.json); }
    if (o.form) opts.body = o.form;
    let r;
    try { r = await fetch(path, opts); } catch (e) { throw new Error('Cannot reach the Sightline server. Is it still running?'); }
    if (r.status === 401 && !o.quiet401) { App.showLogin && App.showLogin(); throw new Error('Please sign in'); }
    if (!r.ok) {
      let d = '';
      try { d = (await r.json()).detail; } catch (e) { /* ignore */ }
      if (Array.isArray(d)) d = d.map((x) => `${(x.loc || []).slice(-1)[0]}: ${x.msg}`).join('; ');
      throw new Error(d || `Request failed (${r.status})`);
    }
    return (r.headers.get('content-type') || '').includes('json') ? r.json() : r;
  }

  function toast(msg, kind) {
    const t = h('div', { class: 'toast ' + (kind || ''), role: 'status' }, msg);
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
  }
  const fail = (e) => { console.error(e); toast(e.message || String(e), 'err'); };

  function modal({ title, body, actions, wide, onClose }) {
    const bg = h('div', { class: 'modal-bg' });
    let closed = false;
    const close = () => { if (closed) return; closed = true; bg.remove(); document.removeEventListener('keydown', esc); onClose && onClose(); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' }, h('h2', null, title), body);
    const bar = h('div', { class: 'actions' });
    (actions || [{ label: 'Close' }]).forEach((a) => {
      bar.appendChild(h('button', { class: 'btn ' + (a.kind || ''), type: 'button', onclick: async (ev) => {
        if (!a.onClick) return close();
        const btn = ev.currentTarget;
        btn.disabled = true;
        try { if ((await a.onClick(close)) === false) btn.disabled = false; else close(); } catch (e) { fail(e); btn.disabled = false; }
      } }, a.label));
    });
    box.appendChild(bar);
    bg.appendChild(box);
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(bg);
    return { close, el: box };
  }
  function confirmDialog(message, label = 'Confirm', kind = 'danger') {
    return new Promise((res) => {
      let answer = false;
      modal({ title: 'Please confirm', body: h('p', null, message), onClose: () => res(answer), actions: [
        { label: 'Cancel' }, { label, kind, onClick: () => { answer = true; } }] });
    });
  }

  const RANK = { viewer: 1, investigator: 2, admin: 3 };
  const can = (role) => (RANK[(App.user || {}).role] || 0) >= RANK[role];
  const fmtTime = (s) => { if (!s) return '-'; const d = new Date(s); return isNaN(d) ? s : d.toLocaleString(); };
  const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const STATUS = { open: 'Open', in_progress: 'In progress', under_review: 'Under review', closed: 'Closed', archived: 'Archived' };
  const badge = (text, cls) => h('span', { class: 'badge ' + (cls || 'b-mut') }, text);
  const statusBadge = (s) => badge(STATUS[s] || s, 'b-' + s);
  const prioBadge = (p) => badge(p, 'b-' + p);
  const demoBadge = (d) => (d ? badge('DEMO DATA', 'b-demo') : null);
  const empty = (t) => h('div', { class: 'empty' }, t);
  const field = (label, input) => h('label', { class: 'f' }, label, input);
  const copy = (text) => { if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', 'err')); };
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const download = (url) => { const a = h('a', { href: url, download: '' }); document.body.appendChild(a); a.click(); a.remove(); };
  const sourceTag = (kind) => h('span', { class: 'src-tag tag-' + kind }, { measured: 'Measured / recorded', model: 'Model output', human: 'Human-entered' }[kind]);
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  async function caseOptions(selected, includeAll) {
    const cases = await api('/api/cases');
    return { cases, options: [includeAll ? h('option', { value: '' }, 'All cases') : null, ...cases.map((c) => h('option', { value: c.id, selected: String(c.id) === String(selected) }, `${c.case_number} - ${c.title}`))] };
  }

  Object.assign(App, { h, svg, icon, api, toast, fail, modal, confirmDialog, can, fmtTime, fmtBytes, STATUS, badge, statusBadge, prioBadge, demoBadge, empty, field, copy, qs, download, sourceTag, caseOptions, debounce });
})();
