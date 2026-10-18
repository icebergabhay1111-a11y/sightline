(function () {
  const { h, api, fmtTime, badge, can, modal, confirmDialog, toast, fail } = App;
  const ROLES = ['viewer', 'investigator', 'admin'];

  App.pages.settings = async (root) => {
    const meta = await api('/api/meta');
    root.append(h('h1', null, 'Settings'), h('p', { class: 'sub' }, 'Interview questions, users, data protection and system information.'));

    // ---- interview questions
    const qBox = h('div', { class: 'card' });
    let qs = await api('/api/questions');
    const drawQ = () => {
      const editable = can('investigator');
      const row = (q, i) => h('div', { class: 'row', style: 'margin-bottom:8px;flex-wrap:nowrap' },
        h('span', { class: 'dim', style: 'width:22px;flex:none' }, i + 1 + '.'),
        h('input', { type: 'text', value: q.text, maxLength: 400, disabled: !editable, style: 'flex:3', 'aria-label': `Question ${i + 1}`, oninput: (e) => { q.text = e.target.value; } }),
        h('input', { type: 'text', value: q.topic || '', maxLength: 40, placeholder: 'topic (optional)', disabled: !editable, style: 'flex:1', 'aria-label': `Topic ${i + 1}`, oninput: (e) => { q.topic = e.target.value; } }),
        editable ? [
          h('button', { class: 'btn small', title: 'Move up', disabled: i === 0, onclick: () => { [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; drawQ(); } }, 'Up'),
          h('button', { class: 'btn small', title: 'Move down', disabled: i === qs.length - 1, onclick: () => { [qs[i + 1], qs[i]] = [qs[i], qs[i + 1]]; drawQ(); } }, 'Down'),
          h('button', { class: 'btn small danger', title: 'Remove', disabled: qs.length <= 1, onclick: () => { qs.splice(i, 1); drawQ(); } }, 'Remove')] : null);
      const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
        const clean = qs.filter((q) => q.text.trim());
        if (!clean.length || clean.some((q) => q.text.trim().length < 3)) return toast('Each question needs at least 3 characters', 'err');
        try { await api('/api/questions', { method: 'PUT', json: { questions: clean.map((q) => ({ text: q.text.trim(), topic: (q.topic || '').trim() })) } }); qs = await api('/api/questions'); drawQ(); toast(`Saved ${qs.length} questions`, 'ok'); } catch (e) { fail(e); }
      } }, 'Save questions');
      qBox.replaceChildren(h('h3', null, 'Interview questions'),
        h('p', { class: 'muted', style: 'margin-top:0' }, 'Edit, reorder, add or remove questions. The optional topic tag lets the summary compare answers on the same subject. Changes apply to new interviews only. Have a legal or forensic expert review the wording: keep questions open, neutral and non-leading.'),
        qs.map(row),
        editable ? h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn', disabled: qs.length >= 30, onclick: () => { qs.push({ text: '', topic: '' }); drawQ(); } }, '+ Add question'), saveBtn,
          h('button', { class: 'btn', onclick: async () => { qs = await api('/api/questions'); drawQ(); } }, 'Discard changes'), h('span', { class: 'dim' }, `${qs.length} question(s)`)) : h('p', { class: 'dim' }, 'Viewers cannot edit questions.'));
    };
    drawQ();
    root.append(qBox);

    // ---- users (admin)
    if (can('admin')) {
      const uBox = h('div', { class: 'card', style: 'margin-top:16px' });
      const resetPassword = (u) => {
        const p = h('input', { type: 'password', placeholder: 'new password (8+ characters)', autocomplete: 'new-password' });
        modal({ title: `Reset password for ${u.username}`, body: p, actions: [{ label: 'Cancel' }, { label: 'Reset', kind: 'primary', onClick: async () => {
          if (p.value.length < 8) { toast('At least 8 characters', 'err'); return false; }
          await api('/api/users/' + u.id, { method: 'PATCH', json: { password: p.value } }); toast('Password reset', 'ok');
        } }] });
        p.focus();
      };
      const drawU = async () => {
        const users = await api('/api/users');
        const un = h('input', { type: 'text', placeholder: 'username', autocomplete: 'off', style: 'width:auto;flex:1' });
        const pw = h('input', { type: 'password', placeholder: 'password (8+ characters)', autocomplete: 'new-password', style: 'width:auto;flex:1' });
        const role = h('select', { style: 'width:auto' }, ROLES.map((r) => h('option', { value: r }, r)));
        const userRow = (u) => h('tr', null, h('td', null, u.username, u.id === App.user.id ? h('span', { class: 'dim' }, ' (you)') : null),
          h('td', null, h('select', { style: 'width:auto', disabled: u.id === App.user.id, 'aria-label': 'role', onchange: async (e) => { try { await api('/api/users/' + u.id, { method: 'PATCH', json: { role: e.target.value } }); toast('Role updated', 'ok'); } catch (x) { fail(x); drawU(); } } },
            ROLES.map((r) => h('option', { value: r, selected: u.role === r }, r)))),
          h('td', null, badge(u.active ? 'active' : 'disabled', u.active ? 'b-ok' : 'b-bad')), h('td', { class: 'dim' }, fmtTime(u.created_at)),
          h('td', null, h('div', { class: 'row' },
            h('button', { class: 'btn small', disabled: u.id === App.user.id, onclick: async () => { try { await api('/api/users/' + u.id, { method: 'PATCH', json: { active: !u.active } }); drawU(); } catch (x) { fail(x); } } }, u.active ? 'Disable' : 'Enable'),
            h('button', { class: 'btn small', onclick: () => resetPassword(u) }, 'Reset password'))));
        uBox.replaceChildren(h('h3', null, 'Users and roles'),
          h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['User', 'Role', 'Status', 'Created', ''].map((t) => h('th', null, t)))), h('tbody', null, users.map(userRow)))),
          h('h3', { style: 'margin-top:14px' }, 'Add user'),
          h('div', { class: 'row' }, un, pw, role, h('button', { class: 'btn primary', onclick: async () => {
            try { await api('/api/users', { method: 'POST', json: { username: un.value.trim(), password: pw.value, role: role.value } }); toast('User created', 'ok'); drawU(); } catch (e) { fail(e); }
          } }, 'Create user')),
          h('p', { class: 'dim', style: 'font-size:12px;margin-bottom:0' }, 'Viewer: read only. Investigator: create and edit cases, upload, analyse, interview, record review decisions. Admin: also delete cases and evidence, manage users, reset demo data.'));
      };
      await drawU();
      root.append(uBox);

      root.append(h('div', { class: 'card', style: 'margin-top:16px' }, h('h3', null, 'Data and privacy controls'),
        h('p', { class: 'muted', style: 'margin-top:0' }, 'Evidence, reference images, audio recordings and face embeddings are encrypted at rest with a key stored in the data folder (data/vault.key). Back up that key: without it the files cannot be read. Reference images expire after their retention period and can be purged here.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: async () => { try { const r = await api('/api/references/purge-expired', { method: 'POST' }); toast(`${r.purged} expired reference image(s) deleted`, 'ok'); } catch (e) { fail(e); } } }, 'Purge expired reference images'),
          h('button', { class: 'btn danger', onclick: async () => {
            if (!(await confirmDialog('Delete all demonstration cases (and their files) and recreate the fictional sample data? Non-demo cases are kept.', 'Reset demo data'))) return;
            try { const r = await api('/api/admin/reset-demo', { method: 'POST' }); toast(`Demo data recreated (${r.cases.length} cases)`, 'ok'); } catch (e) { fail(e); }
          } }, 'Reset demonstration data'))));
    }

    // ---- system
    const v = meta.vision;
    root.append(h('div', { class: 'card', style: 'margin-top:16px' }, h('h3', null, 'System information'),
      h('table', null, h('tbody', null, [['Application', `${meta.app} ${meta.version}`], ['Face detector', v.detector], ['Reference matching', v.matching_available ? 'available (SFace)' : 'not installed (optional)'],
        ['Model files', Object.entries(v.models).map(([k, s]) => `${k}: ${s}`).join('; ') || '-'], ['Face-landmark model', v.landmarker_model_local ? 'local copy (models/face_landmarker.task)' : 'loaded from Google storage on first use'],
        ['Upload limit', meta.max_upload_mb + ' MB'], ['Match reference threshold', meta.match_threshold + ' (cosine; not validated on your data)']]
        .map(([k, val]) => h('tr', null, h('td', { class: 'muted', style: 'width:220px' }, k), h('td', null, val))))),
      v.hint ? h('p', { class: 'dim', style: 'font-size:12px' }, v.hint) : null),
      h('div', { class: 'card', style: 'margin-top:16px' }, h('h3', null, 'Limitations and disclaimer'), h('p', { style: 'margin-top:0' }, meta.disclaimer),
        h('ul', { class: 'muted', style: 'line-height:1.7' },
          h('li', null, 'Published accuracy figures (e.g. SFace 99.40% on LFW, YuNet WIDER FACE AP 0.88/0.87/0.75) come from benchmarks and will not necessarily hold for your cameras, lighting, image quality or population.'),
          h('li', null, 'Face recognition error rates differ between demographic groups, and false matches have led to wrongful arrests elsewhere. Treat every candidate as an unverified lead.'),
          h('li', null, 'Hashing shows a stored file is unchanged since upload; it is not proof of authenticity or a legal chain of custody.'),
          h('li', null, 'Facial-movement measurements cannot establish deception, emotion, stress or guilt.'),
          h('li', null, 'Passwords are PBKDF2-hashed and sessions use signed cookies, but this prototype is not security-audited; do not use real personal data.'))));
  };
})();
