(function () {
  const { h, api, fmtTime, fmtBytes, badge, demoBadge, can, empty, field, modal, confirmDialog, toast, fail, copy } = App;
  const CAVEAT = 'A matching SHA-256 shows the stored bytes are unchanged since upload. It does not prove the file is authentic or original, and it is not a legal chain of custody.';
  const integrityBadge = (v) => (v == null ? badge('not checked', 'b-mut') : v ? badge('hash matches', 'b-ok') : badge('MISMATCH', 'b-bad'));
  const ACCEPT_ALL = '.jpg,.jpeg,.png,.bmp,.webp,.mp4,.avi,.mov,.mkv,.webm,.pdf,.txt,.csv,.json,.docx,.wav,.mp3,.m4a,.ogg';

  function uploader(caseId, onDone, mediaOnly) {
    const files = h('input', { type: 'file', multiple: true, accept: mediaOnly ? '.jpg,.jpeg,.png,.bmp,.webp,.mp4,.avi,.mov,.mkv,.webm' : ACCEPT_ALL });
    const desc = h('input', { type: 'text', maxLength: 1000, placeholder: 'What is this file? (optional)' });
    const demo = h('input', { type: 'checkbox', checked: true });
    const caseSel = h('select');
    const status = h('div', { class: 'muted', style: 'font-size:12px' });
    const btn = h('button', { class: 'btn primary', type: 'button' }, 'Upload');
    if (!caseId) App.caseOptions('').then(({ options }) => caseSel.append(h('option', { value: '' }, 'Choose a case...'), options)).catch(fail);
    btn.onclick = async () => {
      const cid = caseId || caseSel.value;
      if (!cid) return toast('Choose a case first', 'err');
      if (!files.files.length) return toast('Choose at least one file', 'err');
      btn.disabled = true;
      const ids = [];
      try {
        for (const f of files.files) {
          status.textContent = `Uploading ${f.name} ...`;
          const fd = new FormData();
          fd.append('file', f); fd.append('description', desc.value); fd.append('is_demo', demo.checked ? '1' : '0');
          ids.push((await api(`/api/cases/${cid}/evidence`, { method: 'POST', form: fd })).id);
        }
        toast(`${ids.length} file(s) uploaded, encrypted and hashed`, 'ok');
        files.value = ''; desc.value = '';
        onDone && onDone(ids, cid);
      } catch (e) { fail(e); } finally { btn.disabled = false; status.textContent = ''; }
    };
    return h('div', { class: 'card', style: 'margin-bottom:14px' }, h('h3', null, mediaOnly ? 'Upload an image or video' : 'Upload evidence'),
      h('div', { class: mediaOnly ? 'grid' : 'form-grid', style: mediaOnly ? 'gap:10px' : null }, caseId ? null : field('Case', caseSel), field('File(s)', files), field('Description', desc)),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('label', { class: 'chk' }, demo, 'Mark as fictional / demonstration data'), btn, status),
      h('p', { class: 'dim', style: 'font-size:12px;margin:10px 0 0' }, `Files are encrypted at rest, stored under random names, hashed with SHA-256 and limited to ${App.meta ? App.meta.max_upload_mb : 50} MB each. Do not upload real people's data to this prototype.`));
  }

  async function detail(id, onChange) {
    const e = await api('/api/evidence/' + id);
    const noteIn = h('textarea', { rows: 2, placeholder: 'Reviewer note (human-entered)' });
    const verifyOut = h('div');
    const notesBox = h('div'), checksBox = h('div');
    const drawNotes = (notes) => notesBox.replaceChildren(notes.length ? notes.map((n) => h('div', { class: 'list-item' }, h('div', { style: 'white-space:pre-wrap' }, n.text), h('div', { class: 'dim', style: 'font-size:12px;white-space:nowrap' }, `${n.author || ''} ${fmtTime(n.created_at)}`))) : h('p', { class: 'dim' }, 'No notes.'));
    const drawChecks = (checks) => checksBox.replaceChildren(checks.length ? checks.map((c) => h('div', { class: 'list-item' }, h('span', null, integrityBadge(c.ok), ' ', h('span', { class: 'dim' }, c.checked_by || '')), h('span', { class: 'dim' }, fmtTime(c.checked_at)))) : h('p', { class: 'dim' }, 'No checks yet.'));
    drawNotes(e.notes); drawChecks(e.integrity_checks);
    const refresh = async () => { const x = await api('/api/evidence/' + id); drawNotes(x.notes); drawChecks(x.integrity_checks); onChange && onChange(); };
    const body = h('div', null,
      h('div', { class: 'row' }, badge(e.kind, 'b-info'), demoBadge(e.is_demo), h('span', { class: 'muted' }, `${fmtBytes(e.size)} - uploaded ${fmtTime(e.uploaded_at)}`)),
      e.description ? h('p', null, e.description) : null,
      h('div', { class: 'row', style: 'margin:8px 0;flex-wrap:nowrap' }, h('span', { class: 'mono' }, 'SHA-256 ' + e.sha256), h('button', { class: 'btn small', onclick: () => copy(e.sha256) }, 'Copy')),
      e.kind === 'image' ? h('div', { class: 'imgbox', style: 'margin:10px 0' }, h('img', { src: `/api/evidence/${id}/file?inline=1`, alt: 'evidence preview' })) : null,
      h('div', { class: 'notice info' }, CAVEAT),
      h('div', { class: 'row', style: 'margin:12px 0' },
        h('button', { class: 'btn', onclick: async (ev) => {
          const b = ev.currentTarget; b.disabled = true;
          try { const r = await api(`/api/evidence/${id}/verify`, { method: 'POST' }); verifyOut.replaceChildren(h('div', { class: 'notice ' + (r.ok ? 'info' : 'bad') }, (r.ok ? 'Match. ' : 'MISMATCH. ') + r.note)); await refresh(); } catch (x) { fail(x); }
          b.disabled = false;
        } }, 'Verify integrity now'),
        h('button', { class: 'btn', onclick: () => App.download(`/api/evidence/${id}/file`) }, 'Download'),
        (e.kind === 'image' || e.kind === 'video') && can('investigator') ? h('a', { class: 'btn', href: '#/analysis?evidence=' + id }, 'Run face detection') : null),
      verifyOut,
      h('h3', { style: 'margin-top:14px' }, 'Integrity checks'), checksBox,
      h('h3', { style: 'margin-top:14px' }, 'Reviewer notes ', App.sourceTag('human')), notesBox,
      can('investigator') ? h('div', { style: 'margin-top:8px' }, noteIn, h('button', { class: 'btn small', style: 'margin-top:6px', onclick: async () => {
        if (!noteIn.value.trim()) return toast('Write a note first', 'err');
        try { await api(`/api/evidence/${id}/notes`, { method: 'POST', json: { text: noteIn.value } }); noteIn.value = ''; toast('Note added', 'ok'); await refresh(); } catch (x) { fail(x); }
      } }, 'Add note')) : null);
    const actions = [{ label: 'Close' }];
    if (can('admin')) actions.unshift({ label: 'Delete evidence', kind: 'danger', onClick: async () => {
      if (!(await confirmDialog(`Delete "${e.original_name}"? The encrypted file, its notes and its analyses are removed.`, 'Delete'))) return false;
      await api('/api/evidence/' + id, { method: 'DELETE' }); toast('Evidence deleted', 'ok'); onChange && onChange();
    } });
    modal({ title: e.original_name, body, actions, wide: true });
  }

  function table(rows, onChange) {
    return h('div', { class: 'card tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['ID', 'File', 'Case', 'Type', 'Size', 'SHA-256', 'Uploaded', 'Integrity', 'Notes'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((e) => h('tr', { class: 'click', onclick: () => detail(e.id, onChange).catch(fail) },
        h('td', null, e.id), h('td', null, e.original_name, ' ', demoBadge(e.is_demo)), h('td', null, e.case_number || e.case_id), h('td', null, e.kind), h('td', null, fmtBytes(e.size)),
        h('td', { class: 'mono' }, e.sha256.slice(0, 14) + '...'), h('td', { class: 'dim' }, `${fmtTime(e.uploaded_at)} ${e.uploaded_by_name || ''}`), h('td', null, integrityBadge(e.last_integrity_ok)), h('td', null, e.notes_count))))));
  }

  App.evidenceUploader = uploader;
  App.evidenceTable = table;
  App.evidenceDetail = detail;

  App.pages.evidence = async (root, ctx) => {
    const state = { case_id: ctx.query.case || '', kind: '', q: '' };
    const list = h('div');
    const load = async () => { const rows = await api('/api/evidence?' + App.qs(state)); list.replaceChildren(rows.length ? table(rows, () => load().catch(fail)) : empty('No evidence matches.')); };
    const { options } = await App.caseOptions(state.case_id, true);
    root.append(h('h1', null, 'Evidence'), h('p', { class: 'sub' }, 'Uploaded files with timestamps, SHA-256 hashes, reviewer notes and integrity checks.'),
      h('div', { class: 'notice info', style: 'margin-bottom:14px' }, CAVEAT),
      can('investigator') ? uploader(null, () => load().catch(fail)) : null,
      h('div', { class: 'toolbar' },
        h('select', { 'aria-label': 'Case', onchange: (e) => { state.case_id = e.target.value; load().catch(fail); } }, options),
        h('select', { 'aria-label': 'Type', onchange: (e) => { state.kind = e.target.value; load().catch(fail); } }, [['', 'All types'], ['image', 'Images'], ['video', 'Videos'], ['document', 'Documents'], ['audio', 'Audio']].map(([v, t]) => h('option', { value: v }, t))),
        h('input', { type: 'search', placeholder: 'Search name, description or hash', style: 'min-width:260px', oninput: App.debounce((e) => { state.q = e.target.value; load().catch(fail); }) })),
      list);
    await load();
  };
})();
