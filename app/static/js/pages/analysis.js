(function () {
  const { h, api, fmtTime, badge, can, empty, field, toast, fail, confirmDialog } = App;
  const FLAG_HELP = {
    small_face: 'Face narrower than 64 px: matching is unreliable', dark: 'Face region very dark', overexposed: 'Face region very bright',
    low_contrast: 'Low contrast in the face region', blurry: 'Low sharpness (blur or low resolution)', non_frontal: 'Head turned or tilted away from frontal',
    low_resolution: 'Whole image smaller than 640 px on its long side',
  };
  const chips = (flags) => h('div', { class: 'chips' }, (flags || []).length
    ? flags.map((f) => h('span', { class: 'badge b-warn', title: FLAG_HELP[f] || f }, f.replace(/_/g, ' '))) : badge('no quality flags', 'b-ok'));
  const DECISIONS = [['needs_independent_verification', 'Lead - needs independent verification'], ['inconclusive', 'Inconclusive'], ['rejected', 'Rejected - not a match']];
  const thumb = (src, alt) => h('img', { src, width: 56, height: 56, style: 'object-fit:cover;border-radius:6px', alt });

  App.pages.analysis = async (root, ctx) => {
    const status = await api('/api/vision/status');
    const aid = ctx.parts[1];
    const left = h('div'), right = h('div');
    root.append(h('h1', null, 'Face analysis'),
      h('p', { class: 'sub' }, 'Upload an image or video, detect faces, review image quality, and optionally compare a face with consented reference images.'),
      h('div', { class: 'notice warn', style: 'margin-bottom:16px' }, h('b', null, 'Detection is not recognition. '), status.limits),
      h('div', { class: 'grid g-main' }, left, right));

    // ------------------------------------------------------------------ run panel
    const caseSel = h('select'), evSel = h('select'), upHost = h('div');
    const interval = h('input', { type: 'number', min: 0.1, max: 30, step: 0.1, value: 1 });
    const thr = h('input', { type: 'number', min: 0.3, max: 0.99, step: 0.05, value: 0.7, disabled: !status.detector_has_landmarks });
    const runBtn = h('button', { class: 'btn primary', type: 'button' }, 'Run face detection');
    const history = h('div');

    async function loadEvidence(selectId) {
      const evRows = caseSel.value ? (await api('/api/evidence?case_id=' + caseSel.value)).filter((e) => e.kind === 'image' || e.kind === 'video') : [];
      evSel.replaceChildren(h('option', { value: '' }, !caseSel.value ? 'Choose a case first' : evRows.length ? 'Choose image or video...' : 'No image/video evidence yet - upload below'),
        evRows.map((e) => h('option', { value: e.id, selected: String(e.id) === String(selectId) }, `#${e.id} ${e.original_name} (${e.kind})`)));
      upHost.replaceChildren(caseSel.value && can('investigator') ? App.evidenceUploader(caseSel.value, async (ids) => { await loadEvidence(ids[ids.length - 1]); }, true) : null);
      const an = await api('/api/analyses' + (caseSel.value ? '?case_id=' + caseSel.value : ''));
      history.replaceChildren(an.length ? an.slice(0, 12).map((a) => h('div', { class: 'list-item' },
        h('a', { href: '#/analysis/' + a.id }, `#${a.id} ${a.original_name}`), h('span', { class: 'dim', style: 'font-size:12px' }, `${a.face_count_max} face(s) - ${fmtTime(a.created_at)}`))) : h('p', { class: 'dim' }, 'No runs yet.'));
    }
    runBtn.onclick = async () => {
      if (!evSel.value) return toast('Choose an evidence item first', 'err');
      runBtn.disabled = true; runBtn.textContent = 'Detecting...';
      try {
        const r = await api(`/api/evidence/${evSel.value}/analyze`, { method: 'POST', json: { sample_every_s: +interval.value || 1, score_threshold: +thr.value || 0.7 } });
        toast('Detection finished', 'ok');
        location.hash = '#/analysis/' + r.id;
      } catch (e) { fail(e); } finally { runBtn.disabled = false; runBtn.textContent = 'Run face detection'; }
    };
    caseSel.onchange = () => loadEvidence().catch(fail);

    let a = null;
    if (aid) a = await api('/api/analyses/' + aid);
    let presetCase = a ? a.case_id : ctx.query.case || '', presetEv = a ? a.evidence_id : ctx.query.evidence || '';
    if (presetEv && !a) { try { presetCase = (await api('/api/evidence/' + presetEv)).case_id; } catch (e) { presetEv = ''; } }
    const { options } = await App.caseOptions(presetCase);
    caseSel.append(h('option', { value: '' }, 'Choose a case...'), options);
    right.append(h('div', { class: 'card' }, h('h3', null, 'New detection run'),
      h('div', { class: 'grid', style: 'gap:10px' }, field('Case', caseSel), field('Evidence (image or video)', evSel), upHost,
        h('div', { class: 'form-grid' }, field('Video: sample every (s)', interval), field(status.detector_has_landmarks ? 'Min. detector score' : 'Min. score (YuNet only)', thr)),
        can('investigator') ? runBtn : h('p', { class: 'dim' }, 'Viewers cannot run detection.'),
        h('div', { class: 'dim', style: 'font-size:12px' }, 'Detector: ', status.detector, '. ', status.detector_has_landmarks ? '' : status.hint))),
      h('div', { class: 'card' }, h('h3', null, 'Recent runs'), history));
    await loadEvidence(presetEv);

    if (!a) { left.append(empty('Pick evidence and run detection, or open a previous run from the list.')); return; }

    // ------------------------------------------------------------------ viewer
    const res = a.result, frames = res.frames;
    const st = { fi: 0, face: frames[0] && frames[0].faces.length ? 0 : -1 };
    const viewer = h('div'), facesBox = h('div'), matchBox = h('div');
    const frame = () => frames[st.fi];
    const setFrame = (i) => { st.fi = Math.min(Math.max(i, 0), frames.length - 1); st.face = frame().faces.length ? 0 : -1; refresh(); };

    function drawViewer() {
      const f = frame();
      const parts = [h('div', { class: 'imgbox' }, h('img', { alt: 'frame with detected faces outlined', src: `/api/analyses/${aid}/image?frame=${f.index}&face=${st.face}&annotated=1` }))];
      if (a.kind === 'video') {
        parts.push(h('div', { class: 'row', style: 'margin:10px 0;flex-wrap:nowrap' },
          h('button', { class: 'btn small', disabled: st.fi === 0, onclick: () => setFrame(st.fi - 1) }, 'Prev'),
          h('input', { type: 'range', min: 0, max: frames.length - 1, value: st.fi, 'aria-label': 'sampled frame', onchange: (e) => setFrame(+e.target.value) }),
          h('button', { class: 'btn small', disabled: st.fi === frames.length - 1, onclick: () => setFrame(st.fi + 1) }, 'Next'),
          h('span', { class: 'mono', style: 'white-space:nowrap' }, `frame ${f.index} - ${f.t.toFixed(1)} s`)));
        parts.push(h('div', { class: 'card', style: 'margin-top:10px' }, h('h3', null, 'Faces detected over time ', App.sourceTag('model')),
          Charts.line({ t: frames.map((x) => x.t), duration: res.video.duration_s, height: 120, events: [{ t: f.t, type: 'marker', detail: 'current frame' }],
            series: [{ label: 'faces per sampled frame', values: frames.map((x) => x.face_count), color: '#4cc9d6', min: 0 }],
            onSeek: (sec) => { let best = 0; frames.forEach((x, i) => { if (Math.abs(x.t - sec) < Math.abs(frames[best].t - sec)) best = i; }); setFrame(best); } }),
          h('p', { class: 'dim', style: 'font-size:12px;margin:6px 0 0' }, 'Click the chart to jump to the nearest sampled frame. Counts are per sampled frame; faces are not tracked or linked across frames.')));
      }
      viewer.replaceChildren(parts);
    }
    function drawFaces() {
      const f = frame();
      facesBox.replaceChildren(h('h3', null, `Faces in this frame: ${f.face_count} `, App.sourceTag('model')),
        f.faces.length ? h('div', { class: 'grid g3' }, f.faces.map((fc) => h('div', { class: 'face-card' + (fc.index === st.face ? ' sel' : ''), onclick: () => { st.face = fc.index; refresh(); } },
          h('div', { class: 'row', style: 'align-items:flex-start;flex-wrap:nowrap' },
            h('img', { src: `/api/analyses/${aid}/face?frame=${f.index}&index=${fc.index}`, width: 64, height: 64, style: 'object-fit:cover;border-radius:6px;flex:none', alt: `face ${fc.index + 1}` }),
            h('div', null, h('b', null, `Face #${fc.index + 1}`), h('div', { class: 'dim', style: 'font-size:12px' }, `${fc.quality.width}x${fc.quality.height}px`, fc.score != null ? ` - detector score ${fc.score}` : ''),
              h('div', { class: 'dim', style: 'font-size:12px' }, `brightness ${fc.quality.brightness}, sharpness ${fc.quality.sharpness}`, fc.quality.yaw_ratio != null ? `, yaw ratio ${fc.quality.yaw_ratio}` : ''))),
          h('div', { style: 'margin-top:8px' }, chips(fc.quality.flags))))) : empty('No faces detected in this frame. That does not prove nobody is present: faces can be missed.'));
    }
    function summaryCard() {
      const s = res.summary, iq = res.image_quality;
      return h('div', { class: 'card', style: 'margin-bottom:16px' },
        h('div', { class: 'row sp' }, h('h2', { style: 'margin:0' }, `Analysis #${aid} - ${a.evidence_name}`),
          h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#/cases/' + a.case_id + '?tab=Analyses' }, 'Open case'),
            can('investigator') ? h('button', { class: 'btn small danger', onclick: async () => {
              if (!(await confirmDialog('Delete this analysis and its match results? The evidence file is kept.', 'Delete analysis'))) return;
              try { await api('/api/analyses/' + aid, { method: 'DELETE' }); toast('Analysis deleted', 'ok'); location.hash = '#/analysis?case=' + a.case_id; } catch (e) { fail(e); }
            } }, 'Delete') : null)),
        h('div', { class: 'chips', style: 'margin:8px 0' }, badge(a.detector, a.detector.startsWith('YuNet') ? 'b-ok' : 'b-warn'), badge(a.kind, 'b-info'), badge(`${s.frames_analyzed} frame(s) analysed`, 'b-mut'),
          badge(`max ${s.max_faces} face(s) in a frame`, 'b-mut'), badge(`${s.frames_with_faces} frame(s) with faces`, 'b-mut')),
        iq ? h('div', null, h('span', { class: 'muted' }, `Image ${iq.width}x${iq.height} (${iq.megapixels} MP), brightness ${iq.brightness}, contrast ${iq.contrast}, sharpness ${iq.sharpness}.  `), chips(iq.flags)) : null,
        a.kind === 'video' ? h('div', { class: 'muted' }, `Video ${res.video.width}x${res.video.height}, ${res.video.fps} fps, ${res.video.duration_s} s; sampled every ${res.video.sample_every_s} s.`) : null,
        h('p', { class: 'dim', style: 'font-size:12px;margin:6px 0 0' }, `Run ${fmtTime(a.created_at)} with OpenCV ${a.software.opencv || ''}; detector score threshold ${a.params.score_threshold}.`));
    }

    // ------------------------------------------------------------------ matching + human review
    async function drawMatches() {
      const rows = await api(`/api/analyses/${aid}/matches`);
      const f = frame();
      const sel = st.face >= 0 ? f.faces[st.face] : null;
      const head = [h('h3', null, 'Optional reference matching ', App.sourceTag('model'))];
      if (!status.matching_available) {
        head.push(h('div', { class: 'notice info' }, 'Reference matching is not installed (it is optional). ', status.hint || '', ' Detection above works without it.'));
      } else if (can('investigator')) {
        const btn = h('button', { class: 'btn primary', disabled: !sel || !sel.has_landmarks, onclick: async (ev) => {
          const b = ev.currentTarget; b.disabled = true;
          try { await api(`/api/analyses/${aid}/match`, { method: 'POST', json: { frame: f.index, face_index: st.face } }); toast('Comparison finished - review the candidates', 'ok'); await drawMatches(); } catch (e) { fail(e); b.disabled = false; }
        } }, sel ? `Compare face #${st.face + 1} with consented references` : 'Select a face first');
        head.push(h('div', { class: 'row' }, btn, h('span', { class: 'dim', style: 'font-size:12px' }, `Reference cosine threshold ${status.match_threshold} (OpenCV SFace tutorial value; not validated on your data). `, h('a', { href: '#/references' }, 'Manage references'))));
        if (sel && !sel.has_landmarks) head.push(h('div', { class: 'notice warn', style: 'margin-top:8px' }, 'This run used the fallback detector, which gives no landmarks for alignment. Re-run detection now that YuNet is installed.'));
        if (sel && sel.quality.flags.length) head.push(h('div', { class: 'notice warn', style: 'margin-top:8px' }, 'This face has quality limitations (' + sel.quality.flags.join(', ') + '). Scores for it are less reliable.'));
      }
      const groups = {};
      rows.forEach((r) => { (groups[r.run_id] = groups[r.run_id] || []).push(r); });
      const blocks = Object.values(groups).map((g) => {
        g.sort((x, y) => x.rank - y.rank);
        return h('div', { class: 'card', style: 'margin-top:12px;background:var(--panel2)' },
          h('div', { class: 'row sp' }, h('b', null, `Frame ${g[0].frame}, face #${g[0].face_index + 1}`), h('span', { class: 'dim', style: 'font-size:12px' }, fmtTime(g[0].created_at))),
          h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Probe', 'Reference', 'Label', 'Similarity (model)', 'Decision (human)'].map((t) => h('th', null, t)))),
            h('tbody', null, g.map((m) => {
              const dsel = h('select', null, h('option', { value: '' }, m.decision ? 'Change decision...' : 'Record decision...'), DECISIONS.map(([v, t]) => h('option', { value: v, selected: m.decision === v }, t)));
              const note = h('input', { type: 'text', placeholder: 'Reason / note', value: m.decision_note || '' });
              return h('tr', null,
                h('td', null, thumb(`/api/analyses/${aid}/face?frame=${m.frame}&index=${m.face_index}`, 'probe face')),
                h('td', null, m.reference_exists ? thumb(`/api/references/${m.reference_id}/image`, 'reference') : h('span', { class: 'dim' }, 'deleted')),
                h('td', { style: 'min-width:120px' }, `#${m.rank} ${m.reference_label}`),
                h('td', { style: 'min-width:170px' }, h('div', { class: 'row sp', style: 'font-size:12px' }, h('b', null, m.score.toFixed(3)), m.above_threshold ? badge('above ref. threshold', 'b-warn') : badge('below', 'b-mut')),
                  h('div', { class: 'bar', title: 'amber line = reference threshold' }, h('i', { style: `width:${Math.max(0, Math.min(1, m.score)) * 100}%` }), h('b', { style: `left:${m.threshold * 100}%` }))),
                h('td', { style: 'min-width:220px' }, can('investigator') ? h('div', { class: 'grid', style: 'gap:6px' }, dsel, note,
                  h('button', { class: 'btn small', onclick: async () => {
                    if (!dsel.value) return toast('Choose a decision', 'err');
                    try { await api(`/api/matches/${m.id}/review`, { method: 'PATCH', json: { decision: dsel.value, note: note.value } }); toast('Decision recorded', 'ok'); drawMatches().catch(fail); } catch (e) { fail(e); }
                  } }, 'Save decision'),
                  m.decision ? h('span', { class: 'dim', style: 'font-size:12px' }, `Recorded by ${m.decided_by_name} ${fmtTime(m.decided_at)}`) : null) : h('span', null, m.decision || 'unreviewed')));
            })))));
      });
      matchBox.replaceChildren(h('div', { class: 'card' }, head, blocks.length ? blocks : h('p', { class: 'dim', style: 'margin-top:10px' }, 'No comparisons run for this analysis yet.'),
        blocks.length ? h('div', { class: 'notice warn', style: 'margin-top:12px' }, 'Candidates are leads only. False matches and false non-matches happen, performance differs between demographic groups, and image quality limits reliability. Verify independently before any action.') : null));
    }

    function refresh() { drawViewer(); drawFaces(); drawMatches().catch(fail); }
    left.append(summaryCard(), viewer, h('div', { class: 'card', style: 'margin-top:16px' }, facesBox), h('div', { style: 'margin-top:16px' }, matchBox));
    drawViewer(); drawFaces();
    await drawMatches();
  };
})();
