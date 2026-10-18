/* Small dependency-free SVG charts. */
(function () {
  const { h, svg } = App;
  const COL = ['#4cc9d6', '#f2b441', '#a58bff', '#6aa3ff', '#4cc38a', '#ef6a6a', '#8fa0b6'];
  const EVENT_COLOR = { blink: '#4cc9d6', head_turn: '#a58bff', movement_burst: '#f2b441', tracking_lost: '#ef6a6a', low_light: '#6aa3ff', marker: '#4cc38a', eyes_closed_long: '#ef9a6a' };

  function donut(data, size = 150) {
    const total = data.reduce((a, d) => a + d.value, 0);
    const s = svg('svg', { viewBox: '0 0 42 42', width: size, height: size, role: 'img' });
    s.appendChild(svg('circle', { cx: 21, cy: 21, r: 15.9, fill: 'none', stroke: '#202b38', 'stroke-width': 6 }));
    let off = 25;
    data.forEach((d, i) => {
      if (!d.value) return;
      const pct = (d.value / total) * 100;
      s.appendChild(svg('circle', { cx: 21, cy: 21, r: 15.9, fill: 'none', stroke: d.color || COL[i % COL.length], 'stroke-width': 6, 'stroke-dasharray': `${pct} ${100 - pct}`, 'stroke-dashoffset': off }, svg('title', null, `${d.label}: ${d.value}`)));
      off -= pct;
    });
    s.appendChild(svg('text', { x: 21, y: 23.5, 'text-anchor': 'middle', fill: '#e7edf5', 'font-size': 7, 'font-weight': 700 }, String(total)));
    return h('div', { class: 'row', style: 'gap:18px' }, s,
      h('div', { class: 'legend', style: 'flex-direction:column;gap:4px;margin:0' }, data.map((d, i) => h('span', null, h('i', { style: `background:${d.color || COL[i % COL.length]}` }), `${d.label}: ${d.value}`))));
  }

  function bars(data, { height = 150, color = '#4cc9d6' } = {}) {
    const W = 560, pad = 6, max = Math.max(1, ...data.map((d) => d.value));
    const bw = (W - pad * 2) / data.length;
    const s = svg('svg', { viewBox: `0 0 ${W} ${height + 22}`, role: 'img' });
    data.forEach((d, i) => {
      const bh = (d.value / max) * (height - 16);
      s.appendChild(svg('rect', { x: pad + i * bw + 3, y: height - bh, width: Math.max(2, bw - 6), height: Math.max(bh, d.value ? 1 : 0), rx: 3, fill: d.color || color }, svg('title', null, `${d.label}: ${d.value}`)));
      if (d.value) s.appendChild(svg('text', { x: pad + i * bw + bw / 2, y: height - bh - 3, 'text-anchor': 'middle', fill: '#8fa0b6', 'font-size': 10 }, String(d.value)));
      if (data.length <= 16 || i % 2 === 0) s.appendChild(svg('text', { x: pad + i * bw + bw / 2, y: height + 15, 'text-anchor': 'middle', fill: '#64758b', 'font-size': 10 }, d.label));
    });
    return h('div', { class: 'chart' }, s);
  }

  function hbars(data) {
    const max = Math.max(1, ...data.map((d) => d.value));
    return h('div', null, data.map((d, i) => h('div', { style: 'margin:7px 0' },
      h('div', { class: 'row sp', style: 'font-size:12px' }, h('span', null, d.label), h('b', null, d.value)),
      h('div', { class: 'bar' }, h('i', { style: `width:${(d.value / max) * 100}%;background:${d.color || COL[i % COL.length]}` })))));
  }

  /* Time series with event ticks/spans. series: [{label, values, color, min, max}], t: seconds[]; null values break the line. */
  function line({ t, series, events = [], duration, height = 130, title = '', onSeek }) {
    const W = 900, L = 44, R = 10, T = 16, B = 22, ph = height - T - B, pw = W - L - R;
    const s = svg('svg', { viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', style: `height:${height}px`, role: 'img' });
    const dur = duration || (t.length ? t[t.length - 1] : 1) || 1;
    const X = (v) => L + (pw * Math.min(Math.max(v, 0), dur)) / dur;
    s.appendChild(svg('rect', { x: L, y: T, width: pw, height: ph, fill: '#0f151c', stroke: '#263243' }));
    if (title) s.appendChild(svg('text', { x: L, y: 11, fill: '#8fa0b6', 'font-size': 10, 'font-weight': 600 }, title));
    events.filter((e) => e.duration && e.type !== 'blink').forEach((e) => {
      s.appendChild(svg('rect', { x: X(e.t), y: T, width: Math.max(2, X(e.t + e.duration) - X(e.t)), height: ph, fill: EVENT_COLOR[e.type] || '#888', opacity: 0.16 }, svg('title', null, `${e.type} at ${e.t.toFixed(1)} s ${e.detail || ''}`)));
    });
    events.filter((e) => e.type === 'marker').forEach((e) => {
      s.appendChild(svg('line', { x1: X(e.t), x2: X(e.t), y1: T, y2: T + ph, stroke: EVENT_COLOR.marker, 'stroke-dasharray': '3 3', 'stroke-width': 1 }, svg('title', null, e.detail || 'marker')));
    });
    series.forEach((se, si) => {
      const vals = se.values.filter((v) => v != null);
      if (!vals.length) return;
      const lo = se.min != null ? se.min : Math.min(...vals), hi = se.max != null ? se.max : Math.max(...vals), span = hi - lo || 1;
      const step = Math.max(1, Math.ceil(t.length / 900));
      let d = '', pen = false;
      for (let i = 0; i < t.length; i += step) {
        const v = se.values[i];
        if (v == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${X(t[i]).toFixed(1)},${(T + ph - ((v - lo) / span) * ph).toFixed(1)}`;
        pen = true;
      }
      s.appendChild(svg('path', { d, fill: 'none', stroke: se.color, 'stroke-width': 1.3, 'vector-effect': 'non-scaling-stroke' }));
      s.appendChild(svg('text', { x: L - 4, y: T + 10 + si * 10, fill: se.color, 'font-size': 8.5, 'text-anchor': 'end' }, hi.toFixed(1)));
    });
    events.filter((e) => e.type === 'blink').forEach((e) => s.appendChild(svg('line', { x1: X(e.t), x2: X(e.t), y1: T + ph - 6, y2: T + ph, stroke: EVENT_COLOR.blink, 'stroke-width': 1.2 })));
    [0, 0.25, 0.5, 0.75, 1].forEach((f) => s.appendChild(svg('text', { x: L + pw * f, y: height - 7, fill: '#64758b', 'font-size': 9, 'text-anchor': f === 0 ? 'start' : f === 1 ? 'end' : 'middle' }, `${(dur * f).toFixed(0)} s`)));
    if (onSeek) {
      s.style.cursor = 'pointer';
      s.addEventListener('click', (ev) => { const r = s.getBoundingClientRect(); const x = ((ev.clientX - r.left) / r.width) * W; onSeek(Math.min(Math.max(((x - L) / pw) * dur, 0), dur)); });
    }
    return h('div', { class: 'chart' }, s, h('div', { class: 'legend' }, series.map((se) => h('span', null, h('i', { style: `background:${se.color}` }), se.label))));
  }

  function eventLegend() {
    return h('div', { class: 'legend' }, Object.entries(EVENT_COLOR).map(([k, c]) => h('span', null, h('i', { style: `background:${c}` }), k.replace(/_/g, ' '))));
  }

  window.Charts = { donut, bars, hbars, line, eventLegend, COL, EVENT_COLOR };
})();
