/* graph.js - SVG module map: boxes = modules, arrows = calls through API functions.
 * Layered left-to-right layout (callers left, callees right), draggable boxes, pan/zoom.
 */
(function (root) {
'use strict';

const NS = 'http://www.w3.org/2000/svg';
function S(tag, attrs, parent, text) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

class ModuleGraph {
  constructor(svg, handlers) {
    this.svg = svg;
    this.h = handlers || {};
    this.nodes = []; this.edges = []; this.byId = new Map();
    this.view = { x: 0, y: 0, k: 1 };
    this.sel = null; this.drag = null;
    this.opts = { showApi: true, maxRows: 8 };
    this._build();
    this._bind();
  }

  _build() {
    const svg = this.svg;
    svg.innerHTML = '';
    const defs = S('defs', null, svg);
    [['arr-call', 'arrow-call'], ['arr-ref', 'arrow-ref'], ['arr-hl', 'arrow-hl']].forEach(([id, cls]) => {
      const m = S('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '10', markerHeight: '10',
                              markerUnits: 'userSpaceOnUse', orient: 'auto' }, defs);
      S('path', { d: 'M0,0 L10,5 L0,10 z', class: cls }, m);
    });
    this.vp = S('g', { class: 'viewport' }, svg);
    this.gEdges = S('g', { class: 'edges' }, this.vp);
    this.gNodes = S('g', { class: 'nodes' }, this.vp);
  }

  /* ------------------------------------------------------------ data */
  setData(graph, opts) {
    this.opts = Object.assign({ showApi: true, maxRows: 8 }, opts);
    this.nodes = graph.nodes.map(n => {
      const cap = n.external ? Math.min(5, this.opts.maxRows) : this.opts.maxRows;
      const rows = this.opts.showApi ? n.api.slice(0, cap) : [];
      const more = this.opts.showApi ? Math.max(0, n.api.length - rows.length) : 0;
      const wanted = Math.max(n.name.length * 7.4 + 28, ...rows.map(r => r.name.length * 6.7 + 30), 200);
      const w = Math.min(Math.round(wanted), 340);
      const lines = rows.length + (more ? 1 : 0);
      const h = 46 + (lines ? 8 + lines * 17 + 6 : 4);
      return { id: n.id, data: n, rows, more, w, h, x: 0, y: 0 };
    });
    this.byId = new Map(this.nodes.map(n => [n.id, n]));
    this.edges = graph.edges
      .map(e => ({ data: e, a: this.byId.get(e.from), b: this.byId.get(e.to) }))
      .filter(e => e.a && e.b);
    this.sel = null;
    this.relayout(true);
  }

  relayout(fit) {
    this._layout();
    this._render();
    if (fit) this.fit();
  }

  /* ------------------------------------------------------------ layout */
  _layout() {
    const nodes = this.nodes, n = nodes.length;
    if (!n) return;
    const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
    const out = nodes.map(() => []), inn = nodes.map(() => []);
    for (const e of this.edges) {
      const a = idx.get(e.a.id), b = idx.get(e.b.id);
      if (a === b) continue;
      out[a].push(b); inn[b].push(a);
    }
    // break cycles with a DFS (back edges are reversed for layering only)
    const st = new Int8Array(n), dag = [];
    const roots = [...nodes.keys()].sort((a, b) => (inn[a].length - out[a].length) - (inn[b].length - out[b].length));
    const dfs = (u) => {
      st[u] = 1;
      for (const v of out[u]) {
        if (st[v] === 0) { dag.push([u, v]); dfs(v); }
        else if (st[v] === 1) dag.push([v, u]);
        else dag.push([u, v]);
      }
      st[u] = 2;
    };
    for (const r of roots) if (st[r] === 0) dfs(r);
    // longest-path layering
    const indeg = new Int32Array(n), adj = nodes.map(() => []), layer = new Int32Array(n);
    for (const [a, b] of dag) { adj[a].push(b); indeg[b]++; }
    const q = [];
    for (let i = 0; i < n; i++) if (indeg[i] === 0) q.push(i);
    for (let qi = 0; qi < q.length; qi++) {
      const u = q[qi];
      for (const v of adj[u]) { layer[v] = Math.max(layer[v], layer[u] + 1); if (--indeg[v] === 0) q.push(v); }
    }
    // external groups go to the right-most column(s)
    let maxP = -1;
    nodes.forEach((nd, i) => { if (!nd.data.external) maxP = Math.max(maxP, layer[i]); });
    nodes.forEach((nd, i) => { if (nd.data.external) layer[i] = Math.max(layer[i], maxP + 1); });
    const used = [...new Set(layer)].sort((a, b) => a - b);
    const remap = new Map(used.map((l, i) => [l, i]));
    const layers = used.map(() => []);
    nodes.forEach((nd, i) => layers[remap.get(layer[i])].push(i));
    layers.forEach(L => L.sort((a, b) => nodes[a].data.name.localeCompare(nodes[b].data.name)));
    // barycentre ordering to reduce crossings
    const pos = new Float64Array(n);
    const setPos = (L) => L.forEach((v, i) => { pos[v] = L.length > 1 ? i / (L.length - 1) : 0.5; });
    layers.forEach(setPos);
    const nb = nodes.map((_, i) => [...new Set([...out[i], ...inn[i]])]);
    for (let it = 0; it < 8; it++) {
      const seq = it % 2 === 0 ? layers : [...layers].reverse();
      for (const L of seq) {
        const bc = new Map();
        for (const v of L) bc.set(v, nb[v].length ? nb[v].reduce((s, u) => s + pos[u], 0) / nb[v].length : pos[v]);
        L.sort((a, b) => bc.get(a) - bc.get(b));
        setPos(L);
      }
    }
    // coordinates; a layer that would get too tall is split into several adjacent columns
    const GAPX = 115, GAPY = 30, MAXH = 1000;
    const cols = [];
    layers.forEach(L => {
      const total = L.reduce((s, v) => s + nodes[v].h + GAPY, 0) - GAPY;
      const k = Math.max(1, Math.ceil(total / MAXH));
      const target = total / k;
      const chunks = [[]];
      let acc = 0;
      for (const v of L) {
        const h = nodes[v].h;
        if (chunks[chunks.length - 1].length && acc + h > target * 1.1 && chunks.length < k) { chunks.push([]); acc = 0; }
        chunks[chunks.length - 1].push(v);
        acc += h + GAPY;
      }
      chunks.forEach(c => cols.push(c));
    });
    let x = 0;
    const colH = [];
    cols.forEach(L => {
      const w = Math.max(...L.map(v => nodes[v].w));
      let y = 0;
      for (const v of L) { nodes[v].x = x; nodes[v].y = y; y += nodes[v].h + GAPY; }
      colH.push(y - GAPY);
      x += w + GAPX;
    });
    const H = Math.max(...colH);
    cols.forEach((L, i) => { const off = (H - colH[i]) / 2; for (const v of L) nodes[v].y += off; });
  }

  /* ------------------------------------------------------------ rendering */
  _render() {
    this.gEdges.innerHTML = ''; this.gNodes.innerHTML = '';
    for (const n of this.nodes) {
      const g = S('g', { class: 'node' + (n.data.external ? ' ext' : ''), 'data-id': n.id }, this.gNodes);
      n.g = g;
      S('rect', { class: 'box', width: n.w, height: n.h, rx: 9 }, g);
      S('rect', { class: 'head', width: n.w, height: 40, rx: 9 }, g);
      S('rect', { class: 'head', y: 28, width: n.w, height: 12 }, g);
      S('text', { class: 'title', x: 12, y: 19 }, g, trunc(n.data.name, Math.floor((n.w - 20) / 7.4)));
      S('text', { class: 'sub', x: 12, y: 33 }, g,
        n.data.external ? 'external API group · ' + n.data.api.length + ' API used'
                        : n.data.fileCount + ' files · ' + n.data.funcCount + ' functions');
      S('title', null, g, n.data.name);
      n.rowEls = new Map();
      n.rows.forEach((r, i) => {
        const t = S('text', { class: 'row', x: 12, y: 46 + 8 + 12 + i * 17 }, g, trunc(r.name, Math.floor((n.w - 24) / 6.7)));
        S('title', null, t, r.name + '  (used by ' + r.usersList.join(', ') + ')');
        n.rowEls.set(r.name, t);
      });
      if (n.more) S('text', { class: 'row more', x: 12, y: 46 + 8 + 12 + n.rows.length * 17 }, g, '+ ' + n.more + ' more API functions');
      g.setAttribute('transform', `translate(${n.x} ${n.y})`);
      g.addEventListener('pointerdown', (ev) => this._startDrag(ev, 'node', n));
    }
    for (const e of this.edges) {
      const calls = e.data.calls, refs = e.data.refs;
      const g = S('g', { class: 'edge ' + (calls > 0 ? 'call' : 'ref') }, this.gEdges);
      e.g = g;
      e.line = S('path', { class: 'line', 'marker-end': `url(#${calls > 0 ? 'arr-call' : 'arr-ref'})` }, g);
      e.line.setAttribute('stroke-width', (1.3 + Math.min(3.4, Math.log2(e.data.apis.length + 1) * 0.9)).toFixed(2));
      e.hit = S('path', { class: 'hit' }, g);
      e.lblG = S('g', null, g);
      const txt = String(e.data.apis.length);
      const bw = 10 + txt.length * 7;
      S('rect', { class: 'lbl-bg', x: -bw / 2, y: -9, width: bw, height: 18, rx: 9 }, e.lblG);
      S('text', { class: 'lbl' }, e.lblG, txt);
      S('title', null, g, `${e.a.data.name} → ${e.b.data.name}: ${e.data.apis.length} API function(s)`);
      g.addEventListener('click', (ev) => { ev.stopPropagation(); this.select({ type: 'edge', edge: e }); });
      g.addEventListener('mouseenter', () => this._markRows(e, true));
      g.addEventListener('mouseleave', () => this._markRows(e, false));
    }
    this._routeEdges();
    this._applySel();
    this._applyView();
  }

  _routeEdges() {
    for (const n of this.nodes) { n.pL = []; n.pR = []; }
    for (const e of this.edges) {
      const a = e.a, b = e.b;
      if (a === b) continue;
      let sa, sb;
      if (a.x + a.w + 10 < b.x) { sa = 'R'; sb = 'L'; }
      else if (b.x + b.w + 10 < a.x) { sa = 'L'; sb = 'R'; }
      else { sa = 'R'; sb = 'R'; }
      e.sa = sa; e.sb = sb;
      a['p' + sa].push({ e, end: 's', other: b });
      b['p' + sb].push({ e, end: 't', other: a });
    }
    for (const n of this.nodes) {
      for (const side of ['pL', 'pR']) {
        const list = n[side];
        list.sort((p, q) => (p.other.y + p.other.h / 2) - (q.other.y + q.other.h / 2));
        list.forEach((p, k) => {
          const y = n.y + 10 + (n.h - 20) * (k + 1) / (list.length + 1);
          const x = side === 'pR' ? n.x + n.w : n.x;
          if (p.end === 's') { p.e.x1 = x; p.e.y1 = y; } else { p.e.x2 = x; p.e.y2 = y; }
        });
      }
    }
    for (const e of this.edges) {
      if (e.x1 == null || e.x2 == null) continue;
      const dx = Math.max(60, Math.abs(e.x2 - e.x1) / 2);
      const c1 = e.x1 + (e.sa === 'R' ? dx : -dx), c2 = e.x2 + (e.sb === 'R' ? dx : -dx);
      const d = `M${e.x1},${e.y1} C${c1},${e.y1} ${c2},${e.y2} ${e.x2},${e.y2}`;
      e.line.setAttribute('d', d); e.hit.setAttribute('d', d);
      const mx = (e.x1 + 3 * c1 + 3 * c2 + e.x2) / 8, my = (e.y1 + e.y2) / 2;
      e.lblG.setAttribute('transform', `translate(${mx} ${my})`);
    }
  }

  /* ------------------------------------------------------------ selection / highlight */
  select(sel) {
    this.sel = sel;
    this._applySel();
    if (this.h.onSelect) {
      if (!sel) this.h.onSelect(null);
      else if (sel.type === 'node') this.h.onSelect({ type: 'node', node: this.byId.get(sel.id).data });
      else this.h.onSelect({ type: 'edge', edge: sel.edge.data });
    }
  }
  selectNodeById(id) { if (this.byId.has(id)) this.select({ type: 'node', id }); }

  _applySel() {
    const sel = this.sel;
    const relN = new Set(), relE = new Set();
    if (sel && sel.type === 'node') {
      relN.add(sel.id);
      for (const e of this.edges) if (e.a.id === sel.id || e.b.id === sel.id) { relE.add(e); relN.add(e.a.id); relN.add(e.b.id); }
    } else if (sel && sel.type === 'edge') {
      relE.add(sel.edge); relN.add(sel.edge.a.id); relN.add(sel.edge.b.id);
    }
    for (const n of this.nodes) {
      n.g.classList.toggle('dim', !!sel && !relN.has(n.id));
      n.g.classList.toggle('sel', !!sel && sel.type === 'node' && sel.id === n.id);
      for (const t of n.rowEls.values()) t.classList.remove('used');
    }
    for (const e of this.edges) {
      const hl = relE.has(e);
      e.g.classList.toggle('dim', !!sel && !hl);
      e.g.classList.toggle('hl', hl && !!sel);
      e.line.setAttribute('marker-end', `url(#${hl && sel ? 'arr-hl' : (e.data.calls > 0 ? 'arr-call' : 'arr-ref')})`);
      if (hl && sel) this._markRows(e, true, true);
    }
  }

  _markRows(e, on, keep) {
    if (!on && this.sel) { this._applySel(); return; }
    for (const name of e.data.apis) {
      const t = e.b.rowEls.get(name);
      if (t) t.classList.toggle('used', on);
    }
  }

  /* ------------------------------------------------------------ pan / zoom / drag */
  _bind() {
    const svg = this.svg;
    svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = svg.getBoundingClientRect();
      this._zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest && (ev.target.closest('.node') || ev.target.closest('.edge'))) return;
      this._startDrag(ev, 'pan', null);
    });
    svg.addEventListener('pointermove', (ev) => {
      const d = this.drag;
      if (!d || d.id !== ev.pointerId) return;
      const dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (!d.moved) return;
      if (d.kind === 'node') {
        d.node.x = d.ox + dx / this.view.k; d.node.y = d.oy + dy / this.view.k;
        d.node.g.setAttribute('transform', `translate(${d.node.x} ${d.node.y})`);
        this._routeEdges();
      } else {
        this.view.x = d.ox + dx; this.view.y = d.oy + dy;
        this._applyView();
      }
    });
    const end = (ev) => {
      const d = this.drag;
      if (!d || d.id !== ev.pointerId) return;
      this.drag = null;
      if (!d.moved) {
        if (d.kind === 'node') this.select({ type: 'node', id: d.node.id });
        else this.select(null);
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  _startDrag(ev, kind, node) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    try { this.svg.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    this.drag = { kind, node, id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, moved: false,
                  ox: node ? node.x : this.view.x, oy: node ? node.y : this.view.y };
  }

  _zoomAt(px, py, f) {
    const v = this.view;
    const k = Math.max(0.15, Math.min(3, v.k * f));
    f = k / v.k;
    v.x = px - (px - v.x) * f; v.y = py - (py - v.y) * f; v.k = k;
    this._applyView();
  }

  _applyView() {
    const v = this.view;
    this.vp.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.k})`);
  }

  fit() {
    if (!this.nodes.length) return;
    const r = this.svg.getBoundingClientRect();
    const W = r.width || 900, H = r.height || 600;
    const b = this._bbox();
    const k = Math.min(W / b.w, H / b.h, 1.15);
    this.view = { k, x: (W - b.w * k) / 2 - b.x * k, y: (H - b.h * k) / 2 - b.y * k };
    this._applyView();
  }

  _bbox() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
    const pad = 50;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad + 36 };   // extra room for the legend
  }

  /* ------------------------------------------------------------ export */
  exportSVG() {
    const clone = this.svg.cloneNode(true);
    const orig = this.svg.querySelectorAll('*'), cl = clone.querySelectorAll('*');
    const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'font-family', 'font-size', 'font-weight',
                   'font-style', 'opacity', 'text-anchor', 'dominant-baseline'];
    orig.forEach((o, i) => {
      const cs = getComputedStyle(o);
      let st = '';
      for (const p of props) st += `${p}:${cs.getPropertyValue(p)};`;
      cl[i].setAttribute('style', st);
    });
    const b = this._bbox();
    const vp = clone.querySelector('g.viewport');
    if (vp) vp.removeAttribute('transform');
    clone.removeAttribute('style'); clone.removeAttribute('class');
    clone.setAttribute('viewBox', `${b.x} ${b.y} ${b.w} ${b.h}`);
    clone.setAttribute('width', Math.round(b.w)); clone.setAttribute('height', Math.round(b.h));
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('x', b.x); bg.setAttribute('y', b.y); bg.setAttribute('width', b.w); bg.setAttribute('height', b.h);
    bg.setAttribute('fill', getComputedStyle(document.body).backgroundColor || '#fff');
    clone.insertBefore(bg, clone.querySelector('g.viewport'));
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  }
}

root.ModuleGraph = ModuleGraph;
})(window);
