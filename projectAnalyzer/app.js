/* app.js - UI logic for the nRF54L project analyzer */
(() => {
'use strict';

const C = window.NcsCore;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const tick = () => new Promise((r) => setTimeout(r, 0));
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const fmt = (n) => Number(n).toLocaleString();

/* ------------------------------------------------------------------ settings */
const DEFAULTS = {
  exclude: 'build, .git, node_modules, twister-out, _build, .west, __pycache__',
  exts: 'c, h, cpp, cc, hpp, hh',
  moduleMap: '',
  externalRules: C.DEFAULT_EXTERNAL_RULES,
  depth: '2'
};
const LS_KEY = 'nrf54l-analyzer-settings-v1';
function loadSettings() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ } }

const state = {
  rootName: '', roots: [], nextRootId: 1, entries: [], entryMap: new Map(), parsed: new Map(), parseErrors: 0, model: null,
  settings: loadSettings(), sel: null, sort: { key: 'name', dir: 1 }, limit: 400, rowCache: {},
  graph: null, mapDirty: true, tab: 'overview', extByName: new Map(), runId: 0
};

/* ------------------------------------------------------------------ tabs / progress */
function setTab(name) {
  state.tab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'map') ensureMap();
}
function progress(frac, text) {
  $('#progress').hidden = false;
  $('#progressBar').style.width = Math.round(frac * 100) + '%';
  $('#progressText').textContent = text;
}
const hideProgress = () => { $('#progress').hidden = true; };

/* ------------------------------------------------------------------ loading files */
/* A project can consist of several folders (e.g. app + zephyr + nrf). With more than one folder,
 * every path is prefixed with its folder name so paths stay unique (myapp/src/main.c, zephyr/kernel/sem.c). */
function uniqueRootName(name) {
  let base = name || 'folder', n = base, i = 2;
  while (state.roots.some((r) => r.name === n)) n = base + ' (' + i++ + ')';
  return n;
}
function rebuildEntries() {
  const multi = state.roots.length > 1;
  state.entries = [];
  for (const r of state.roots) {
    for (const e of r.entries) {
      state.entries.push({ file: e.file, key: r.id + ':' + e.path, path: multi ? r.name + '/' + e.path : e.path });
    }
  }
  state.entryMap = new Map(state.entries.map((e) => [e.path, e]));
  state.rootName = state.roots.map((r) => r.name).join(' + ');
}
function setEntries(root, entries) {            // replace everything
  state.roots = [{ id: state.nextRootId++, name: root || 'project', entries }];
  state.parsed = new Map();
  state.parseErrors = 0;
  rebuildEntries();
  return runAnalysis();
}
function addEntries(root, entries) {            // merge another folder into the project
  if (!state.roots.length) return setEntries(root, entries);
  state.roots.push({ id: state.nextRootId++, name: uniqueRootName(root), entries });
  rebuildEntries();
  return runAnalysis();
}
function removeRoot(id) {
  if (state.roots.length < 2) return;
  state.roots = state.roots.filter((r) => r.id !== id);
  for (const k of [...state.parsed.keys()]) if (k.startsWith(id + ':')) state.parsed.delete(k);
  rebuildEntries();
  runAnalysis();
}
function renderRoots() {
  const host = $('#rootLabel');
  if (!state.roots.length) { host.textContent = ''; return; }
  host.innerHTML = state.roots.map((r) =>
    `<span class="chip" title="${esc(r.entries.length)} files">${esc(r.name)}${state.roots.length > 1 ? ` <button type="button" data-root="${r.id}" title="Remove this folder">×</button>` : ''}</span>`).join('');
}

function fromFileList(fileList) {
  const items = [...fileList].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
  return splitRoot(items);
}
function splitRoot(items) {
  let root = '';
  if (items.length) {
    const first = items[0].path.split('/')[0];
    if (items.every((i) => i.path.split('/').length > 1 && i.path.split('/')[0] === first)) root = first;
  }
  return { root, entries: items.map((i) => ({ file: i.file, path: root ? i.path.slice(root.length + 1) : i.path })) };
}

async function readDropped(entries) {
  const excl = new Set(splitList(state.settings.exclude));
  const exts = new Set(splitList(state.settings.exts).map((e) => e.replace(/^\./, '').toLowerCase()));
  const out = [];
  let n = 0;
  async function walk(entry) {
    if (entry.isFile) {
      const ext = (entry.name.split('.').pop() || '').toLowerCase();
      if (!exts.has(ext)) return;
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: entry.fullPath.replace(/^\//, '') });
      if (++n % 50 === 0) progress(0.02, 'Reading folder… ' + fmt(n) + ' source files found');
    } else if (entry.isDirectory) {
      if (excl.has(entry.name)) return;
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e);
  return out;
}

function loadDemo() {
  const entries = window.DEMO_FILES.map((f) => ({
    path: f.path,
    file: { size: f.content.length, text: () => Promise.resolve(f.content) }
  }));
  return setEntries('nrf54l-demo (built-in sample)', entries);
}

/* ------------------------------------------------------------------ analysis pipeline */
async function runAnalysis() {
  const myRun = ++state.runId;
  const s = state.settings;
  const excl = new Set(splitList(s.exclude));
  const exts = new Set(splitList(s.exts).map((e) => e.replace(/^\./, '').toLowerCase()));
  const files = state.entries.filter((e) => {
    const segs = e.path.split('/');
    if (segs.slice(0, -1).some((x) => excl.has(x))) return false;
    const ext = (segs[segs.length - 1].split('.').pop() || '').toLowerCase();
    return exts.has(ext) && (e.file.size == null || e.file.size < 3000000);
  });
  const todo = files.filter((e) => !state.parsed.has(e.key));
  progress(0, 'Scanning ' + fmt(files.length) + ' source files…');
  await tick();
  const BATCH = 16;
  for (let i = 0; i < todo.length; i += BATCH) {
    if (myRun !== state.runId) return;
    const chunk = todo.slice(i, i + BATCH);
    const texts = await Promise.all(chunk.map((e) => Promise.resolve(e.file.text()).catch(() => '')));
    chunk.forEach((e, j) => {
      let pf;
      try { pf = C.parseSource(texts[j], e.path); } catch (err) {
        state.parseErrors++;
        pf = { path: e.path, functions: [], protos: [], macros: [], includes: [], fileRefs: [] };
      }
      state.parsed.set(e.key, pf);
    });
    progress((i + chunk.length) / Math.max(1, todo.length), 'Parsed ' + fmt(Math.min(i + BATCH, todo.length)) + ' / ' + fmt(todo.length) + ' files');
    await tick();
  }
  if (myRun !== state.runId) return;
  progress(1, 'Resolving calls and modules…');
  await tick();
  const depth = (s.depth === 'file' || s.depth === 'full') ? s.depth : Number(s.depth);
  state.model = C.analyze(files.map((e) => Object.assign({}, state.parsed.get(e.key), { path: e.path })), { depth, moduleMap: s.moduleMap, externalRules: s.externalRules });
  hideProgress();
  renderAll();
}

/* ------------------------------------------------------------------ render everything */
function renderAll() {
  const m = state.model;
  state.sel = null;
  state.rowCache = {};
  state.limit = 400;
  state.extByName = new Map(m.externals.map((x) => [x.name, x.id]));
  renderRoots();
  $('#depthSel').value = String(state.settings.depth);
  renderOverview();
  syncModuleSel();
  renderTable();
  renderDetail(null);
  state.mapDirty = true;
  if (state.tab === 'map') ensureMap();
  if (state.tab === 'overview' && m.stats.functions > 0) { /* stay on overview */ }
}

/* ------------------------------------------------------------------ overview */
const link = (id, text, cls) => `<a href="#" class="symlink ${cls || ''}" data-id="${esc(id)}">${esc(text)}</a>`;

function renderOverview() {
  const m = state.model, st = m.stats;
  const host = $('#overviewStats');
  $('#dropZone').hidden = true;
  host.hidden = false;
  if (!st.functions) {
    $('#dropZone').hidden = false; host.hidden = true;
    $('#dropZone').querySelector('h2').textContent = 'No C functions found';
    return;
  }
  // cross-module numbers per module
  const modInfo = new Map(m.modules.map((x) => [x.name, { name: x.name, files: x.files.length, funcs: x.funcs.length, out: 0, inn: 0 }]));
  for (const fn of m.functions) for (const o of fn.out) {
    if (o.t === 'fn' && o.module !== fn.module) { modInfo.get(fn.module).out += o.count; modInfo.get(o.module).inn += o.count; }
  }
  const mods = [...modInfo.values()].sort((a, b) => b.funcs - a.funcs);
  const topIn = [...m.functions].sort((a, b) => b.inCalls.length - a.inCalls.length).slice(0, 10).filter((f) => f.inCalls.length);
  const topOut = [...m.functions].sort((a, b) => b.out.length - a.out.length).slice(0, 10).filter((f) => f.out.length);
  const unref = m.functions.filter((f) => !f.isStatic && f.name !== 'main' && !f.inCalls.length && !f.refBy.length && f.kind === 'function');

  const card = (n, l) => `<div class="card"><div class="n">${fmt(n)}</div><div class="l">${l}</div></div>`;
  let html = '';
  if (state.parseErrors) html += `<div class="notice">${state.parseErrors} file(s) could not be parsed and were skipped.</div>`;
  if (st.externalApis > st.functions * 0.6 && st.extGroups.length) {
    html += `<div class="notice">Many called functions are <b>not defined</b> in the scanned folder (Zephyr, NCS, nrfx …). They are grouped into <i>external API groups</i> on the module map.
      For a deeper view use <b>Add folder…</b> to add <code>zephyr/</code>, <code>nrf/</code> and <code>modules/hal/nordic/</code> (or just the parts you need).</div>`;
  }
  html += `<div class="cards">
    ${card(st.files, 'source files')}${card(st.functions, 'functions defined')}${card(st.globals, 'global (extern)')}
    ${card(st.statics, 'static')}${card(st.modules, 'modules')}${card(st.callEdges, 'call relations')}
    ${card(st.externalApis, 'external APIs used')}${card(st.macros, 'function-like macros')}</div>`;
  html += '<div class="grid2">';
  html += `<div class="panel"><h3>Modules</h3><table><tr><th>Module</th><th class="num">Files</th><th class="num">Functions</th><th class="num">Calls out</th><th class="num">Calls in</th></tr>` +
    mods.map((x) => `<tr><td><a href="#" class="modlink" data-mod="${esc(x.name)}">${esc(x.name)}</a></td><td class="num">${x.files}</td><td class="num">${x.funcs}</td><td class="num">${x.out}</td><td class="num">${x.inn}</td></tr>`).join('') +
    '</table><p class="muted" style="margin:8px 0 0">“Calls out/in” count calls that cross module borders. Change the module granularity on the Module map tab.</p></div>';
  html += `<div class="panel"><h3>External API groups used</h3><table><tr><th>Group</th><th class="num">APIs</th><th class="num">Calls</th></tr>` +
    st.extGroups.map((g) => `<tr><td>${esc(g.name)}</td><td class="num">${g.apis}</td><td class="num">${g.calls}</td></tr>`).join('') +
    '</table></div>';
  html += `<div class="panel"><h3>Most called functions</h3><table><tr><th>Function</th><th>Module</th><th class="num">Callers</th></tr>` +
    topIn.map((f) => `<tr><td>${link(f.id, f.name)}</td><td>${esc(f.module)}</td><td class="num">${f.inCalls.length}</td></tr>`).join('') + '</table></div>';
  html += `<div class="panel"><h3>Functions with most dependencies</h3><table><tr><th>Function</th><th>Module</th><th class="num">Calls</th></tr>` +
    topOut.map((f) => `<tr><td>${link(f.id, f.name)}</td><td>${esc(f.module)}</td><td class="num">${f.out.length}</td></tr>`).join('') + '</table></div>';
  html += `<div class="panel"><h3>Global functions never called in scanned code (${unref.length})</h3>
    <p class="muted" style="margin:0 0 6px">Entry points (callbacks, public API) or possibly dead code.</p><table>` +
    unref.slice(0, 15).map((f) => `<tr><td>${link(f.id, f.name)}</td><td>${esc(f.module)}</td></tr>`).join('') +
    (unref.length > 15 ? `<tr><td colspan="2" class="muted">… ${unref.length - 15} more (see Functions tab)</td></tr>` : '') + '</table></div>';
  html += '</div>';
  host.innerHTML = html;
}

/* ------------------------------------------------------------------ function table */
const COLS = {
  fn: [['name', 'Function'], ['module', 'Module'], ['loc', 'File : line'], ['out', 'Calls', 'num'], ['inn', 'Called by', 'num'], ['scope', 'Scope']],
  ext: [['name', 'External API'], ['module', 'Group'], ['loc', 'Declared in'], ['inn', 'Used by (fns)', 'num'], ['count', 'Calls', 'num'], ['scope', 'Matched by']],
  macro: [['name', 'Macro'], ['module', 'Module'], ['loc', 'File : line'], ['inn', 'Used by (fns)', 'num']]
};

function baseRows(kind) {
  if (state.rowCache[kind]) return state.rowCache[kind];
  const m = state.model;
  let rows;
  if (kind === 'fn') {
    rows = m.functions.map((f) => ({ id: f.id, name: f.name, module: f.module, loc: f.file + ':' + f.line, out: f.out.length,
      inn: f.inCalls.length, scope: f.isStatic ? 'static' : 'global' }));
  } else if (kind === 'ext') {
    rows = m.externals.map((x) => ({ id: x.id, name: x.name, module: x.group, loc: x.file ? x.file + ':' + x.line : '—',
      inn: new Set(x.callers).size, count: x.count, scope: x.type === 'ext' ? 'name rule' : x.type === 'decl' ? 'header decl' : 'unclassified' }));
  } else {
    rows = m.macros.map((x) => ({ id: x.id, name: x.name, module: x.module, loc: x.file + ':' + x.line, inn: new Set(x.callers).size, scope: 'macro' }));
  }
  return (state.rowCache[kind] = rows);
}

function syncModuleSel() {
  const kind = $('#kindSel').value, m = state.model, sel = $('#moduleSel');
  const prev = sel.value;
  let names;
  if (!m) names = [];
  else if (kind === 'ext') names = [...new Set(m.externals.map((x) => x.group))];
  else names = m.modules.map((x) => x.name);
  names.sort((a, b) => a.localeCompare(b));
  sel.innerHTML = `<option value="">${kind === 'ext' ? 'All groups' : 'All modules'}</option>` +
    names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = names.includes(prev) ? prev : '';
  $('#scopeSel').disabled = kind !== 'fn';
}

function getRows() {
  const kind = $('#kindSel').value;
  const q = $('#searchInput').value.trim().toLowerCase();
  const mod = $('#moduleSel').value, scope = kind === 'fn' ? $('#scopeSel').value : '';
  const base = baseRows(kind);
  let rows = base;
  if (q || mod || scope) {
    rows = base.filter((r) => (!mod || r.module === mod) && (!scope || r.scope === scope) &&
      (!q || r.name.toLowerCase().includes(q) || r.loc.toLowerCase().includes(q)));
  }
  const { key, dir } = state.sort;
  const numeric = typeof base[0] !== 'undefined' && typeof base[0][key] === 'number';
  rows = rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    const c = numeric ? (x - y) : String(x == null ? '' : x).localeCompare(String(y == null ? '' : y));
    return (c || a.name.localeCompare(b.name)) * dir;
  });
  return { rows, total: base.length, kind };
}

function renderTable() {
  if (!state.model) return;
  const { rows, total, kind } = getRows();
  state.rows = rows;
  const cols = COLS[kind];
  if (!cols.some((c) => c[0] === state.sort.key)) state.sort = { key: 'name', dir: 1 };
  $('#fnHead').innerHTML = '<tr>' + cols.map(([k, t, cls]) =>
    `<th data-key="${k}" class="${cls || ''} ${state.sort.key === k ? 'sorted' + (state.sort.dir < 0 ? ' desc' : '') : ''}">${t}</th>`).join('') + '</tr>';
  const shown = rows.slice(0, state.limit);
  $('#fnBody').innerHTML = shown.map((r) =>
    `<tr data-id="${esc(r.id)}" class="${String(r.id) === String(state.sel) ? 'sel' : ''}">` +
    cols.map(([k, , cls]) => `<td class="${cls || ''} ${k === 'name' ? 'name' : ''}" title="${esc(r[k] == null ? '' : r[k])}">${esc(r[k] == null ? '' : r[k])}</td>`).join('') + '</tr>').join('');
  $('#countLabel').textContent = rows.length === total ? fmt(total) + ' entries' : fmt(rows.length) + ' of ' + fmt(total);
  const more = $('#moreBtn');
  more.hidden = rows.length <= state.limit;
  more.textContent = 'Show more (' + fmt(rows.length - state.limit) + ' remaining)';
}

/* ------------------------------------------------------------------ selecting a symbol */
function parseId(v) { return /^\d+$/.test(v) ? Number(v) : v; }

function selectSymbol(id, opts) {
  opts = opts || {};
  const sym = state.model.sym(id);
  if (!sym) return;
  state.sel = id;
  if (!opts.fromTable) {
    const kind = sym.kind === 'external' ? 'ext' : sym.kind === 'macro' ? 'macro' : 'fn';
    setTab('functions');
    if ($('#kindSel').value !== kind) { $('#kindSel').value = kind; syncModuleSel(); }
    let idx = getRows().rows.findIndex((r) => String(r.id) === String(id));
    if (idx < 0) { $('#searchInput').value = ''; $('#moduleSel').value = ''; $('#scopeSel').value = ''; idx = getRows().rows.findIndex((r) => String(r.id) === String(id)); }
    if (idx >= state.limit) state.limit = idx + 200;
    renderTable();
    const tr = $(`#fnBody tr[data-id="${CSS.escape(String(id))}"]`);
    if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'center' });
  } else {
    $$('#fnBody tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === String(id)));
  }
  renderDetail(sym);
}

/* ------------------------------------------------------------------ detail panel */
const capList = (items, cap) => {
  cap = cap || 200;
  return '<ul class="list">' + items.slice(0, cap).join('') + '</ul>' +
    (items.length > cap ? `<div class="muted">… ${items.length - cap} more</div>` : '');
};
const lineOf = (file, line) => `${esc(file)}:${line}`;

function renderDetail(sym) {
  const host = $('#detail');
  if (!sym) { host.innerHTML = '<div class="empty">Select a function to see what it calls, who calls it, and its call tree.</div>'; return; }
  if (sym.kind === 'external') return detailExternal(host, sym);
  if (sym.kind === 'macro') return detailMacro(host, sym);
  detailFunction(host, sym);
}

function callersOf(sym) {
  const m = state.model;
  const map = new Map();
  const list = sym.kind === 'external' || sym.kind === 'macro' ? sym.callers.map((id) => ({ from: id })) : sym.inCalls;
  for (const c of list) {
    const e = map.get(c.from) || { from: c.from, lines: [] };
    if (c.line) e.lines.push(c.line);
    map.set(c.from, e);
  }
  return [...map.values()].map((e) => {
    const f = m.functions[e.from];
    return `<li>${link(f.id, f.name)}${f.module !== sym.module ? ` <span class="badge">${esc(f.module)}</span>` : ''}<span class="ln">${e.lines.length ? 'line ' + e.lines.slice(0, 3).join(', ') + (e.lines.length > 3 ? '…' : '') : ''}</span></li>`;
  });
}

function detailFunction(host, fn) {
  const m = state.model;
  const proj = [], exts = [], macs = [];
  for (const o of fn.out) (o.t === 'fn' ? proj : o.t === 'macro' ? macs : exts).push(o);
  const callerItems = callersOf(fn);
  const refItems = fn.refBy.map((r) => r.scope
    ? `<li><span class="badge">file scope</span> <span class="mono">${esc(r.file)}</span><span class="ln">registration / table</span></li>`
    : `<li>${link(r.from, m.functions[r.from].name)}</li>`);
  let h = `<h2>${esc(fn.name)}</h2>
    <div><span class="badge">${esc(fn.module)}</span> <span class="badge ${fn.isStatic ? 'warn' : ''}">${fn.isStatic ? 'static' : 'global'}</span>
    ${fn.isInline ? '<span class="badge">inline</span>' : ''}${fn.kind === 'macro-block' ? ' <span class="badge mac">macro block</span>' : ''}</div>
    <pre class="sig">${esc(fn.signature)}</pre>
    <dl class="kv"><dt>File</dt><dd>${lineOf(fn.file, fn.line)}${fn.endLine > fn.line ? '–' + fn.endLine : ''}</dd>
    <dt>Size</dt><dd>${fn.endLine - fn.line + 1} lines</dd>
    <dt>Calls</dt><dd>${fn.out.length} distinct (${proj.length} project, ${exts.length} external)</dd>
    <dt>Called by</dt><dd>${callerItems.length} function(s)</dd></dl>`;
  h += `<h4>Calls — project functions (${proj.length})</h4>`;
  h += proj.length ? capList(proj.map((o) => {
    const t = m.functions[o.to];
    return `<li>${link(t.id, t.name)}${t.module !== fn.module ? ` <span class="badge">${esc(t.module)}</span>` : ''}${o.count > 1 ? ` <span class="muted">×${o.count}</span>` : ''}<span class="ln">line ${o.line}</span></li>`;
  })) : '<div class="muted">none</div>';
  h += `<h4>Calls — external APIs (${exts.length})</h4>`;
  h += exts.length ? capList(exts.map((o) => {
    const cls = o.t === 'unk' ? 'warn' : 'ext';
    return `<li>${link(o.to, o.name)} <span class="badge ${cls}">${esc(o.module)}</span>${o.count > 1 ? ` <span class="muted">×${o.count}</span>` : ''}<span class="ln">line ${o.line}</span></li>`;
  })) : '<div class="muted">none</div>';
  if (macs.length) {
    h += `<h4>Calls — function-like macros (${macs.length})</h4>` + capList(macs.map((o) => `<li>${link(o.to, o.name)}<span class="ln">line ${o.line}</span></li>`));
  }
  if (fn.indirect.length) {
    h += `<h4>Calls through pointers / struct members (${fn.indirect.length})</h4>` +
      capList(fn.indirect.map((o) => `<li><span class="mono">…${esc(o.name)}()</span>${o.count > 1 ? ` <span class="muted">×${o.count}</span>` : ''}<span class="ln">line ${o.line}</span></li>`)) +
      '<div class="muted" style="font-size:12px">Targets of function-pointer calls cannot be resolved statically.</div>';
  }
  if (fn.refsOut.length) {
    h += `<h4>Passes / registers as callback (${fn.refsOut.length})</h4>` +
      capList(fn.refsOut.map((id) => { const t = m.functions[id]; return `<li>${link(t.id, t.name)}${t.module !== fn.module ? ` <span class="badge">${esc(t.module)}</span>` : ''}</li>`; }));
  }
  h += `<h4>Called by (${callerItems.length})</h4>` + (callerItems.length ? capList(callerItems) : '<div class="muted">not called directly in scanned code</div>');
  if (refItems.length) h += `<h4>Referenced as callback / in tables (${refItems.length})</h4>` + capList(refItems);
  h += '<h4>Call tree</h4><div id="treeHost"></div>';
  h += '<h4>Source</h4><button class="btn" id="srcBtn" type="button">Show source</button><div id="srcHost"></div>';
  host.innerHTML = h;
  host.scrollTop = 0;
  buildTree($('#treeHost'), fn);
  $('#srcBtn').addEventListener('click', () => showSource(fn));
}

function detailExternal(host, x) {
  const callers = callersOf(x);
  const how = x.type === 'ext' ? 'matched an external API group rule' : x.type === 'decl' ? 'declared in a scanned header, definition not in scanned sources' : 'no definition, declaration or group rule found';
  host.innerHTML = `<h2>${esc(x.name)}</h2>
    <div><span class="badge ${x.type === 'unk' ? 'warn' : 'ext'}">${esc(x.group)}</span> <span class="badge ext">external</span></div>
    <p class="muted">Not defined in the scanned sources — ${how}.</p>
    <dl class="kv"><dt>Declared</dt><dd>${x.file ? lineOf(x.file, x.line) : '—'}</dd><dt>Calls</dt><dd>${x.count} call site(s) in ${new Set(x.callers).size} function(s)</dd></dl>
    <h4>Called by (${callers.length})</h4>${capList(callers)}`;
  host.scrollTop = 0;
}

function detailMacro(host, x) {
  const callers = callersOf(x);
  host.innerHTML = `<h2>${esc(x.name)}</h2><div><span class="badge">${esc(x.module)}</span> <span class="badge mac">function-like macro</span></div>
    <dl class="kv"><dt>Defined</dt><dd>${lineOf(x.file, x.line)}</dd></dl>
    <h4>Used by (${callers.length})</h4>${capList(callers)}`;
  host.scrollTop = 0;
}

/* call tree: lazily expanded */
function buildTree(host, fn) {
  const ul = document.createElement('ul');
  ul.className = 'tree';
  host.appendChild(ul);
  fillTree(ul, fn, new Set([fn.id]));
  if (!ul.children.length) ul.innerHTML = '<li class="muted">no calls</li>';
}
function fillTree(ul, fn, path) {
  const m = state.model;
  const seen = new Set();
  for (const o of fn.out) {
    if (o.t === 'macro' || o.t === 'unk') continue;
    const key = o.t + ':' + o.to;
    if (seen.has(key)) continue;
    seen.add(key);
    const li = document.createElement('li');
    if (o.t === 'fn') {
      const t = m.functions[o.to];
      const mod = t.module !== fn.module ? ` <span class="badge">${esc(t.module)}</span>` : '';
      const expandable = t.out.some((x) => x.t !== 'macro' && x.t !== 'unk');
      if (path.has(t.id)) {
        li.innerHTML = `<div class="leaf">${link(t.id, t.name)} <span class="rec">↻ recursion</span></div>`;
      } else if (!expandable) {
        li.innerHTML = `<div class="leaf">${link(t.id, t.name)}${mod}</div>`;
      } else {
        const d = document.createElement('details');
        d.innerHTML = `<summary>${link(t.id, t.name)}${mod}</summary>`;
        d.addEventListener('toggle', () => {
          if (!d.open || d.dataset.done) return;
          d.dataset.done = '1';
          const sub = document.createElement('ul');
          d.appendChild(sub);
          fillTree(sub, t, new Set([...path, t.id]));
        });
        li.appendChild(d);
      }
    } else {
      li.innerHTML = `<div class="leaf">${link(o.to, o.name)} <span class="badge ext">${esc(o.module)}</span></div>`;
    }
    ul.appendChild(li);
  }
}

async function showSource(fn) {
  const hostEl = $('#srcHost');
  const entry = state.entryMap.get(fn.file);
  if (!entry) { hostEl.textContent = 'File not available.'; return; }
  try {
    const text = await entry.file.text();
    const lines = text.split(/\r?\n/);
    const from = Math.max(0, fn.line - 1), to = Math.min(lines.length, fn.endLine, from + 400);
    hostEl.innerHTML = '<pre class="src">' + lines.slice(from, to).map((l, i) =>
      `<div><span class="l">${from + i + 1}</span>${esc(l)}</div>`).join('') + '</pre>' +
      (fn.endLine - fn.line > 400 ? '<div class="muted">(truncated to 400 lines)</div>' : '');
  } catch (e) { hostEl.textContent = 'Could not read file: ' + e.message; }
  $('#srcBtn').hidden = true;
}

/* ------------------------------------------------------------------ module map */
function ensureMap() {
  if (!state.graph) {
    state.graph = new window.ModuleGraph($('#mapSvg'), { onSelect: showMapSelection });
  }
  if (state.mapDirty) drawMap();
}

function mapOpts() {
  return { externals: $('#optExt').checked, unclassified: $('#optUnk').checked, refs: $('#optRefs').checked, hideIsolated: $('#optIso').checked };
}

function drawMap() {
  state.mapDirty = false;
  const g = state.model ? C.buildModuleGraph(state.model, mapOpts()) : { nodes: [], edges: [] };
  state.graphData = g;
  state.graph.setData(g, { showApi: $('#optApi').checked });
  $('#mapEmpty').hidden = g.nodes.length > 0;
  showMapSelection(null);
}

function extLink(name, fnId) {
  if (fnId != null) return link(fnId, name);
  const id = state.extByName.get(name);
  return id ? link(id, name) : `<span class="mono">${esc(name)}</span>`;
}
const nodeLink = (id) => `<a href="#" class="nodelink" data-node="${esc(id)}">${esc(id)}</a>`;

function showMapSelection(sel) {
  const host = $('#mapInfo'), g = state.graphData;
  if (!g || !g.nodes.length) { host.innerHTML = '<div class="empty">Open a project to see its module map.</div>'; return; }
  const m = state.model;
  if (!sel) {
    const deg = new Map(g.nodes.map((n) => [n.id, { o: 0, i: 0 }]));
    g.edges.forEach((e) => { deg.get(e.from).o++; deg.get(e.to).i++; });
    host.innerHTML = `<h2>Module map</h2>
      <p class="muted">Each box is a software module (folder). An arrow means “calls functions of”. The number on an arrow is the count of
      distinct API functions used. Functions listed inside a box are the ones other modules use — the module's API.
      Click a box or an arrow for details.</p>
      <dl class="kv"><dt>Modules</dt><dd>${g.nodes.filter((n) => !n.external).length} project, ${g.nodes.filter((n) => n.external).length} external groups</dd>
      <dt>Relations</dt><dd>${g.edges.length} module-to-module links</dd></dl>
      <h4>All boxes</h4>` +
      capList(g.nodes.map((n) => `<li>${nodeLink(n.id)}${n.external ? ' <span class="badge ext">external</span>' : ''}<span class="ln">→ ${deg.get(n.id).o} · ← ${deg.get(n.id).i}</span></li>`), 400);
    return;
  }
  if (sel.type === 'node') {
    const n = sel.node;
    const outE = g.edges.filter((e) => e.from === n.id), inE = g.edges.filter((e) => e.to === n.id);
    let h = `<h2>${esc(n.name)}</h2><div>${n.external ? '<span class="badge ext">external API group</span>' : '<span class="badge">project module</span>'}</div>`;
    if (!n.external) h += `<dl class="kv"><dt>Files</dt><dd>${n.fileCount}</dd><dt>Functions</dt><dd>${n.funcCount}</dd></dl>`;
    h += `<h4>API used by other modules (${n.api.length})</h4>`;
    h += n.api.length ? capList(n.api.map((a) => `<li>${extLink(a.name, a.fnId)}<span class="ln">${esc(a.usersList.join(', '))}</span></li>`), 300) : '<div class="muted">nothing</div>';
    h += `<h4>Uses other modules (${outE.length})</h4>`;
    h += outE.length ? capList(outE.map((e) => `<li>${nodeLink(e.to)} <span class="badge">${e.apis.length} API</span><span class="ln">${esc(e.apis.slice(0, 3).join(', '))}${e.apis.length > 3 ? '…' : ''}</span></li>`)) : '<div class="muted">none</div>';
    h += `<h4>Used by modules (${inE.length})</h4>`;
    h += inE.length ? capList(inE.map((e) => `<li>${nodeLink(e.from)} <span class="badge">${e.apis.length} API</span></li>`)) : '<div class="muted">none</div>';
    if (!n.external) {
      const mod = m.modules.find((x) => x.name === n.id);
      if (mod) h += `<h4>Open in function list</h4><a href="#" class="modlink" data-mod="${esc(n.id)}">Show all ${mod.funcs.length} functions of this module</a>`;
    }
    host.innerHTML = h;
  } else {
    const e = sel.edge;
    host.innerHTML = `<h2>${nodeLink(e.from)} → ${nodeLink(e.to)}</h2>
      <p class="muted">${e.calls} call(s)${e.refs ? ', ' + e.refs + ' callback reference(s)' : ''} through ${e.apis.length} API function(s).</p>
      <h4>Caller → API function</h4>` +
      capList(e.items.slice().sort((a, b) => a.dstName.localeCompare(b.dstName)).map((it) => {
        const src = it.srcFn == null ? '<span class="badge">file scope</span>' : link(it.srcFn, m.functions[it.srcFn].name);
        return `<li>${src} <span class="muted">→</span> ${extLink(it.dstName, it.dstFn)} ${it.kind === 'ref' ? '<span class="badge ext">callback ref</span>' : ''}${it.count > 1 ? ` <span class="muted">×${it.count}</span>` : ''}</li>`;
      }), 400);
  }
  host.scrollTop = 0;
}

/* ------------------------------------------------------------------ export */
function download(name, text, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function needModel() { if (!state.model) { alert('Open a project first.'); return false; } return true; }

function exportJson() {
  if (!needModel()) return;
  const m = state.model;
  const out = {
    project: state.rootName, generatedBy: 'nRF54L Project Analyzer', stats: m.stats,
    modules: m.modules.map((x) => ({ name: x.name, files: x.files, functions: x.funcs.map((i) => m.functions[i].name) })),
    functions: m.functions.map((f) => ({
      name: f.name, module: f.module, file: f.file, line: f.line, endLine: f.endLine, static: f.isStatic, signature: f.signature,
      calls: f.out.map((o) => ({ name: o.name, kind: o.t, module: o.module, line: o.line, count: o.count })),
      callsViaPointer: f.indirect.map((o) => o.name),
      passesAsCallback: f.refsOut.map((i) => m.functions[i].name),
      calledBy: [...new Set(f.inCalls.map((c) => m.functions[c.from].name))]
    })),
    externalApis: m.externals.map((x) => ({ name: x.name, group: x.group, calls: x.count, usedBy: [...new Set(x.callers.map((i) => m.functions[i].name))] })),
    moduleGraph: (state.graphData || C.buildModuleGraph(m, mapOpts())).edges.map((e) => ({
      from: e.from, to: e.to, apiFunctions: e.apis, calls: e.calls, callbackRefs: e.refs }))
  };
  download((state.rootName || 'project').replace(/[^\w.-]+/g, '_') + '-analysis.json', JSON.stringify(out, null, 1), 'application/json');
}
function exportCsv() {
  if (!needModel()) return;
  const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = [['function', 'module', 'file', 'line', 'scope', 'calls', 'called_by', 'signature'].join(',')];
  for (const f of state.model.functions) {
    lines.push([f.name, f.module, f.file, f.line, f.isStatic ? 'static' : 'global', f.out.length, f.inCalls.length, f.signature].map(q).join(','));
  }
  download((state.rootName || 'project').replace(/[^\w.-]+/g, '_') + '-functions.csv', lines.join('\n'), 'text/csv');
}
function exportSvg() {
  if (!needModel()) return;
  if (state.tab !== 'map') setTab('map');
  ensureMap();
  if (!state.graph.nodes.length) { alert('The module map is empty.'); return; }
  download((state.rootName || 'project').replace(/[^\w.-]+/g, '_') + '-module-map.svg', state.graph.exportSVG(), 'image/svg+xml');
}

/* ------------------------------------------------------------------ settings dialog */
function openSettings() {
  const s = state.settings;
  $('#setExclude').value = s.exclude;
  $('#setExts').value = s.exts;
  $('#setModMap').value = s.moduleMap;
  $('#setExtRules').value = s.externalRules;
  $('#settingsDlg').showModal();
}
function applySettings() {
  const s = state.settings;
  s.exclude = $('#setExclude').value;
  s.exts = $('#setExts').value;
  s.moduleMap = $('#setModMap').value;
  s.externalRules = $('#setExtRules').value;
  saveSettings();
  $('#settingsDlg').close();
  if (state.entries.length) runAnalysis();
}

/* ------------------------------------------------------------------ events */
function bind() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

  $('#folderInput').addEventListener('change', (ev) => {
    const list = ev.target.files;
    if (!list || !list.length) return;
    const { root, entries } = fromFileList(list);
    ev.target.value = '';
    setEntries(root, entries);
  });
  $('#addFolderInput').addEventListener('change', (ev) => {
    const list = ev.target.files;
    if (!list || !list.length) return;
    const { root, entries } = fromFileList(list);
    ev.target.value = '';
    addEntries(root, entries);
  });
  $('#rootLabel').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-root]');
    if (b) removeRoot(Number(b.dataset.root));
  });
  $('#demoBtn').addEventListener('click', loadDemo);
  $('#demoBtn2').addEventListener('click', loadDemo);

  // drag & drop anywhere
  const dz = $('#dropZone');
  ['dragenter', 'dragover'].forEach((t) => window.addEventListener(t, (ev) => { ev.preventDefault(); dz.classList.add('over'); }));
  window.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) dz.classList.remove('over'); });
  window.addEventListener('drop', async (ev) => {
    ev.preventDefault(); dz.classList.remove('over');
    const items = ev.dataTransfer && ev.dataTransfer.items;
    if (!items) return;
    const ents = [...items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (!ents.length) return;
    progress(0.02, 'Reading folder…');
    try {
      const list = await readDropped(ents);
      const { root, entries } = splitRoot(list);
      await (ev.shiftKey ? addEntries(root, entries) : setEntries(root, entries));   // Shift+drop = add folder
    } catch (e) { hideProgress(); alert('Could not read the dropped folder: ' + e.message); }
  });

  // settings
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#setClose').addEventListener('click', () => $('#settingsDlg').close());
  $('#setApply').addEventListener('click', applySettings);
  $('#setReset').addEventListener('click', () => {
    $('#setExclude').value = DEFAULTS.exclude; $('#setExts').value = DEFAULTS.exts;
    $('#setModMap').value = DEFAULTS.moduleMap; $('#setExtRules').value = DEFAULTS.externalRules;
  });

  // export
  const closeMenu = () => { $('#exportMenu').open = false; };
  $('#expJson').addEventListener('click', () => { closeMenu(); exportJson(); });
  $('#expCsv').addEventListener('click', () => { closeMenu(); exportCsv(); });
  $('#expSvg').addEventListener('click', () => { closeMenu(); exportSvg(); });

  // function list controls
  $('#kindSel').addEventListener('change', () => { state.limit = 400; syncModuleSel(); renderTable(); });
  let timer = 0;
  $('#searchInput').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.limit = 400; renderTable(); }, 120); });
  $('#moduleSel').addEventListener('change', () => { state.limit = 400; renderTable(); });
  $('#scopeSel').addEventListener('change', () => { state.limit = 400; renderTable(); });
  $('#moreBtn').addEventListener('click', () => { state.limit += 800; renderTable(); });
  $('#fnHead').addEventListener('click', (ev) => {
    const th = ev.target.closest('th');
    if (!th) return;
    const k = th.dataset.key;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
    renderTable();
  });
  $('#fnBody').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr');
    if (tr) selectSymbol(parseId(tr.dataset.id), { fromTable: true });
  });

  // links anywhere
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('a.symlink, a.modlink, a.nodelink');
    if (!a) return;
    ev.preventDefault();
    if (a.classList.contains('symlink')) selectSymbol(parseId(a.dataset.id));
    else if (a.classList.contains('modlink')) {
      setTab('functions');
      $('#kindSel').value = 'fn'; syncModuleSel();
      $('#searchInput').value = ''; $('#scopeSel').value = '';
      $('#moduleSel').value = a.dataset.mod;
      state.limit = 400; renderTable();
    } else if (a.classList.contains('nodelink') && state.graph) state.graph.selectNodeById(a.dataset.node);
  });

  // module map controls
  $('#depthSel').addEventListener('change', (ev) => {
    state.settings.depth = ev.target.value; saveSettings();
    if (state.entries.length) runAnalysis();
  });
  ['optExt', 'optUnk', 'optRefs', 'optApi', 'optIso'].forEach((id) => $('#' + id).addEventListener('change', () => { if (state.graph) drawMap(); }));
  $('#fitBtn').addEventListener('click', () => state.graph && state.graph.fit());
  $('#relayoutBtn').addEventListener('click', () => state.graph && state.graph.relayout(true));
  window.addEventListener('resize', () => { if (state.tab === 'map' && state.graph) state.graph.fit(); });
}

bind();
$('#depthSel').value = String(state.settings.depth);
})();
