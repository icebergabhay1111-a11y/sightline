(function () {
  const { h, api, fmtTime, badge, demoBadge, can, empty, field, toast, fail, confirmDialog } = App;

  App.pages.references = async (root) => {
    const status = await api('/api/vision/status');
    const list = h('div');
    const file = h('input', { type: 'file', accept: '.jpg,.jpeg,.png,.bmp,.webp' });
    const label = h('input', { type: 'text', maxLength: 80, placeholder: 'Pseudonym or code, e.g. REF-01 (consented demo)' });
    const consentRef = h('input', { type: 'text', maxLength: 120, placeholder: 'Consent form number' });
    const consent = h('input', { type: 'checkbox', name: 'consent' });
    const days = h('input', { type: 'number', min: 1, max: 365, value: 30 });
    const demo = h('input', { type: 'checkbox', checked: true });
    const enabled = status.matching_available && can('investigator');
    const btn = h('button', { class: 'btn primary', type: 'button', disabled: !enabled }, 'Enrol reference image');

    async function load() {
      const rows = await api('/api/references');
      list.replaceChildren(rows.length ? h('div', { class: 'grid g3' }, rows.map((r) => h('div', { class: 'card' },
        h('div', { class: 'row', style: 'align-items:flex-start;flex-wrap:nowrap' },
          h('img', { src: `/api/references/${r.id}/image`, width: 84, height: 84, style: 'object-fit:cover;border-radius:8px;flex:none', alt: 'reference ' + r.label }),
          h('div', { style: 'min-width:0' }, h('b', null, r.label), ' ', demoBadge(r.is_demo), h('div', { class: 'dim', style: 'font-size:12px' }, 'Consent ref: ' + r.consent_ref),
            h('div', { class: 'dim', style: 'font-size:12px' }, `Added ${fmtTime(r.created_at)}`), h('div', { style: 'margin-top:4px' }, r.expired ? badge('expired - not used for matching', 'b-bad') : badge('review by ' + r.review_by, 'b-ok')))),
        h('div', { style: 'margin-top:8px' }, h('div', { class: 'chips' }, (r.quality.flags || []).length ? r.quality.flags.map((f) => badge(f.replace(/_/g, ' '), 'b-warn')) : badge('no quality flags', 'b-ok'))),
        can('investigator') ? h('button', { class: 'btn small danger', style: 'margin-top:10px', onclick: async () => {
          if (!(await confirmDialog(`Delete reference "${r.label}" and its stored embedding?`, 'Delete'))) return;
          try { await api('/api/references/' + r.id, { method: 'DELETE' }); toast('Reference deleted', 'ok'); load().catch(fail); } catch (e) { fail(e); }
        } }, 'Delete') : null))) : empty('No reference images enrolled.'));
    }

    btn.onclick = async () => {
      if (!file.files[0]) return toast('Choose an image', 'err');
      if (!label.value.trim() || !consentRef.value.trim()) return toast('Label and consent reference are required', 'err');
      if (!consent.checked) return toast('Consent must be confirmed', 'err');
      btn.disabled = true;
      try {
        const fd = new FormData();
        fd.append('image', file.files[0]); fd.append('label', label.value); fd.append('consent_ref', consentRef.value); fd.append('consent_confirmed', '1');
        fd.append('is_demo', demo.checked ? '1' : '0'); fd.append('retention_days', days.value || '30');
        const r = await api('/api/references', { method: 'POST', form: fd });
        toast(r.quality.flags.length ? 'Enrolled with quality warnings: ' + r.quality.flags.join(', ') : 'Reference enrolled', r.quality.flags.length ? '' : 'ok');
        file.value = ''; label.value = ''; consentRef.value = ''; consent.checked = false;
        await load();
      } catch (e) { fail(e); } finally { btn.disabled = false; }
    };

    root.append(h('h1', null, 'Reference images'), h('p', { class: 'sub' }, 'An authorised collection of consented (or synthetic) images used only for the optional comparison in Face analysis.'),
      h('div', { class: 'notice warn', style: 'margin-bottom:16px' }, 'Only enrol images of people who have given documented consent, or synthetic/licensed demonstration images. Do not scrape photos or build a database of real people. Images and their numeric embeddings are encrypted at rest and expire after the retention period.'),
      !status.matching_available ? h('div', { class: 'notice info', style: 'margin-bottom:16px' }, 'Matching models are not installed, so enrolment is disabled. ', status.hint || '') : null,
      h('div', { class: 'card' }, h('h3', null, 'Enrol a reference'), h('div', { class: 'form-grid' }, field('Image (exactly one face)', file), field('Label (pseudonym / code)', label), field('Consent form reference', consentRef), field('Retention (days)', days)),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('label', { class: 'chk' }, consent, 'This person has given documented consent for their image to be used for this demonstration.'), h('label', { class: 'chk' }, demo, 'Demonstration data'), btn)),
      h('div', { class: 'row sp', style: 'margin:18px 0 8px' }, h('h2', { style: 'margin:0' }, 'Enrolled references'),
        can('admin') ? h('button', { class: 'btn small', onclick: async () => { try { const r = await api('/api/references/purge-expired', { method: 'POST' }); toast(`${r.purged} expired reference(s) deleted`, 'ok'); load().catch(fail); } catch (e) { fail(e); } } }, 'Purge expired') : null),
      list);
    await load();
  };
})();
