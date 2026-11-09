/* core.js - C source scanner + analysis model for nRF54L / NCS projects
 * No dependencies. Works in the browser (window.NcsCore) and in node (module.exports).
 */
(function (root) {
'use strict';

/* ------------------------------------------------------------------ constants */

const KEYWORDS = new Set(('if else while for do switch case default return break continue goto sizeof typeof ' +
  '__typeof__ _Alignof alignof __alignof__ _Static_assert static_assert defined offsetof int char short long ' +
  'float double void signed unsigned struct union enum typedef static extern const volatile inline register ' +
  'auto _Bool bool __attribute__ __asm__ asm __asm _Generic __extension__ __volatile__ __inline__ new delete ' +
  'catch throw').split(' '));
const NOT_CALLS = new Set('container_of va_start va_end va_arg va_copy assert min max'.split(' '));
const ATTR_NAMES = new Set(('__attribute__ __aligned __printf_like __scanf_like __section __asm__ __asm asm ' +
  '__deprecated __DEPRECATED_MACRO _Alignas __declspec').split(' '));
const MACRO_LIKE = /^[A-Z_][A-Z0-9_]*$/;
const TRANSPARENT = /^\s*(extern\s*""|(inline\s+)?namespace\b[^;(){}]*)\s*$/;

const DEFAULT_EXTERNAL_RULES = [
  '# Group name : regex matched against the function name.',
  '# Used for functions that are called but NOT defined in the scanned sources',
  '# (e.g. Zephyr / NCS / nrfx APIs when only the application folder is scanned).',
  '# First match wins. Lines starting with # are ignored.',
  'Bluetooth Host : ^(bt_|hci_)',
  'Nordic SDC / MPSL : ^(sdc_|mpsl_|nrf_802154|esb_)',
  'Crypto / Security : ^(psa_|mbedtls_|tfm_|nrf_cc|nrf_security|sha[0-9_]|aes_|cracen|ocrypto)',
  'DFU / Bootloader : ^(boot_|mcuboot|dfu_|mcumgr|smp_|fw_info|pcd_|fota|img_mgmt|os_mgmt)',
  'NCS Libraries : ^(dk_|nrf_dm|nrf_rpc|nus_|lbs_|bas_|hrs_|app_event|caf_|date_time|dult|fmdn|hids_|ancs|gatt_dm)',
  'Power Mgmt : ^(pm_|sys_poweroff|sys_reboot|power_)',
  'nrfx HAL : ^(nrfx_|nrfy_|nrf_|hal_nrf_)',
  'Storage / Settings : ^(settings_|nvs_|fs_|fcb_|zms_|flash_area_|flash_map_|stream_flash_|nvmem_|disk_)',
  'Zephyr Drivers : ^(device_|gpio_|uart_|spi_|i2c_|i2s_|adc_|pwm_|counter_|dma_|flash_|sensor_|can_|usb_|wdt_|clock_control_|pinctrl_|regulator_|entropy_|eeprom_|display_|led_|hwinfo_|comparator_|mbox_|ipc_|retained_mem_|rtc_|w1_|reset_|audio_|video_|input_)',
  'Zephyr Kernel : ^(k_|z_|irq_|arch_|atomic_|printk|vprintk|assert_)',
  'Logging & Shell : ^(log_|shell_|z_log|__z_log)',
  'Networking : ^(net_|zsock|socket|dns_|coap_|mqtt_|lwm2m_|http_|sntp_|openthread|ot[A-Z]|zb_|zigbee|matter)',
  'libc / Utilities : ^(sys_|ring_buf_|net_buf_|base64_|json_|crc|mem(cpy|set|cmp|move|chr)|str|snprintf|sprintf|printf|vsnprintf|vsprintf|abs$|atoi|atol|malloc|free$|calloc|realloc|qsort|bsearch|rand|srand|time$|puts|putchar|exit$|abort$)'
].join('\n');

/* ------------------------------------------------------------------ cleaning */

function countNl(s) { let c = 0, p = -1; while ((p = s.indexOf('\n', p + 1)) !== -1) c++; return c; }

/** Removes comments, string/char literals and preprocessor lines (keeping line breaks).
 *  Also records #include and function-like #define, and drops `#if 0` regions. */
function clean(src) {
  const n = src.length, parts = [], includes = [], macros = [], stack = [];
  let i = 0, last = 0, bol = true, line = 1, zero = 0;

  const flush = (to) => {
    if (to <= last) return;
    const t = src.slice(last, to);
    line += countNl(t);
    if (zero > 0) { const k = countNl(t); if (k) parts.push('\n'.repeat(k)); } else parts.push(t);
    last = to;
  };
  const skip = (from, to, repl) => {
    flush(from);
    const nl = countNl(src.slice(from, to));
    line += nl;
    parts.push(zero > 0 ? '\n'.repeat(nl) : repl + '\n'.repeat(nl));
    last = to;
  };
  const directive = (raw, dl) => {
    const m = /^#\s*(\w+)\s*([\s\S]*)$/.exec(raw);
    if (!m) return;
    const kw = m[1];
    const rest = m[2].replace(/\/\*[\s\S]*?\*\/|\/\/.*$/g, '').trim();
    switch (kw) {
      case 'include': {
        if (zero === 0) { const mm = /^[<"]([^>"]+)[>"]/.exec(rest); if (mm) includes.push(mm[1]); }
        break;
      }
      case 'define': {
        if (zero === 0) { const mm = /^([A-Za-z_]\w*)\(/.exec(rest); if (mm) macros.push({ name: mm[1], line: dl }); }
        break;
      }
      case 'if': { const z = /^0+$/.test(rest); stack.push({ zero: z, starts: [parts.length] }); if (z) zero++; break; }
      case 'ifdef': case 'ifndef': stack.push({ zero: false, starts: [parts.length] }); break;
      case 'elif': case 'else': {
        const top = stack[stack.length - 1];
        if (top) {
          if (top.zero) { top.zero = false; zero--; }
          top.starts.push(parts.length);
        }
        break;
      }
      case 'endif': {
        const g = stack.pop();
        if (!g) break;
        if (g.zero) zero--;
        g.starts.push(parts.length);
        if (g.starts.length > 2) resolveBranches(g.starts);
        break;
      }
    }
  };

  // #if A {  #else  {  #endif  would count the brace twice. Alternatives are mutually exclusive, so among the
  // branches that are NOT brace-balanced by themselves only the first one is kept (balanced branches are all kept,
  // so alternative function definitions still show up).
  const braceDelta = (s) => { let d = 0; for (let k = 0; k < s.length; k++) { const c = s.charCodeAt(k); if (c === 123) d++; else if (c === 125) d--; } return d; };
  const resolveBranches = (starts) => {
    let keptUnbalanced = false;
    for (let b = 0; b < starts.length - 1; b++) {
      const from = starts[b], to = starts[b + 1];
      if (to <= from) continue;
      if (braceDelta(parts.slice(from, to).join('')) === 0) continue;
      if (!keptUnbalanced) { keptUnbalanced = true; continue; }
      for (let k = from; k < to; k++) { const nl = countNl(parts[k]); parts[k] = nl ? '\n'.repeat(nl) : ''; }
    }
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 10) { bol = true; i++; continue; }
    if (c === 32 || c === 9 || c === 13) { i++; continue; }
    if (c === 35 && bol) {                         // '#': preprocessor directive
      flush(i);
      const dl = line;
      let e = i;
      for (;;) {
        const k = src.indexOf('\n', e);
        if (k === -1) { e = n; break; }
        const p1 = src.charCodeAt(k - 1), p2 = src.charCodeAt(k - 2);
        if (p1 === 92 || (p1 === 13 && p2 === 92)) { e = k + 1; continue; }
        e = k; break;
      }
      directive(src.slice(i, e).replace(/\\\r?\n/g, ' '), dl);
      skip(i, e, '');
      i = e; continue;
    }
    if (c === 47) {                                 // '/'
      const nx = src.charCodeAt(i + 1);
      if (nx === 47) { let e = src.indexOf('\n', i); if (e === -1) e = n; skip(i, e, ' '); i = e; continue; }
      if (nx === 42) { let e = src.indexOf('*/', i + 2); e = e === -1 ? n : e + 2; skip(i, e, ' '); i = e; continue; }
    } else if (c === 34 || c === 39) {              // string / char literal
      let e = i + 1;
      while (e < n) {
        const d = src.charCodeAt(e);
        if (d === 92) { e += 2; continue; }
        if (d === c) { e++; break; }
        if (d === 10) break;
        e++;
      }
      skip(i, e, c === 34 ? '""' : '0');
      i = e; bol = false; continue;
    }
    bol = false; i++;
  }
  flush(n);
  return { text: parts.join(''), includes, macros };
}

/* ------------------------------------------------------------------ structure parsing */

function matchBrace(t, i) {
  let d = 0;
  for (let k = i, n = t.length; k < n; k++) {
    const c = t.charCodeAt(k);
    if (c === 123) d++;
    else if (c === 125) { d--; if (d === 0) return k; }
  }
  return -1;
}

function macroBlockName(name, params) {
  const ids = params.split(',').map(s => s.trim()).filter(s => /^[A-Za-z_]\w*$/.test(s));
  return ids.length ? ids.join('_') : name;
}

/** Decides whether the text in front of a '{' at file scope is a function header. */
function parseFuncHeader(raw) {
  const lead = raw.length - raw.trimStart().length;
  let h = raw.trim();
  if (!h) return null;
  h = h.replace(/\s*__attribute__\s*\(\([^{};]*\)\)\s*$/, '');
  if (h.charCodeAt(h.length - 1) !== 41) return null;
  let d = 0, k = h.length - 1;
  for (; k >= 0; k--) {
    const ch = h.charCodeAt(k);
    if (ch === 41) d++;
    else if (ch === 40) { d--; if (d === 0) break; }
  }
  if (k <= 0) return null;
  const before = h.slice(0, k);
  const m = /([A-Za-z_]\w*)\s*$/.exec(before);
  if (!m) return null;
  const name = m[1];
  if (KEYWORDS.has(name) || ATTR_NAMES.has(name)) return null;
  const prefix = before.slice(0, m.index).trim();
  if (/^typedef\b/.test(prefix)) return null;
  if (/=/.test(prefix.replace(/\([^()]*\)/g, ''))) return null;
  const params = h.slice(k + 1, h.length - 1);
  const p0 = prefix.replace(/\([^()]*\)/g, '');
  if (MACRO_LIKE.test(name)) {
    if (prefix) return null;
    return { kind: 'macro-block', name: macroBlockName(name, params), nameIdx: lead + m.index, isStatic: false, isInline: false,
             signature: name + '(' + params.replace(/\s+/g, ' ').trim() + ')' };
  }
  const pre = prefix.length > 90 ? prefix.slice(-90) : prefix;
  return {
    kind: 'function', name, nameIdx: lead + m.index,
    isStatic: /\bstatic\b/.test(p0), isInline: /\binline\b/.test(p0),
    signature: ((pre ? pre.replace(/\s+/g, ' ') + ' ' : '') + name + '(' + params.replace(/\s+/g, ' ').trim() + ')')
  };
}

/** Function prototype at file scope ("int foo(int a);") */
function parseProto(s) {
  if (/[={}]/.test(s)) return null;
  const groups = [];
  let d = 0, start = -1;
  for (let k = 0; k < s.length; k++) {
    const ch = s.charCodeAt(k);
    if (ch === 40) { if (d === 0) start = k; d++; }
    else if (ch === 41) { d--; if (d < 0) return null; if (d === 0) groups.push([start, k]); }
  }
  if (d !== 0 || !groups.length) return null;
  for (let g = groups.length - 1; g >= 0; g--) {
    const st = groups[g][0];
    const before = s.slice(0, st);
    const m = /([A-Za-z_]\w*)\s*$/.exec(before);
    if (!m) continue;
    const name = m[1];
    if (ATTR_NAMES.has(name)) continue;
    if (KEYWORDS.has(name) || MACRO_LIKE.test(name)) return null;
    const prefix = before.slice(0, m.index).trim();
    if (!prefix) return null;
    return { name, signature: s.replace(/\s+/g, ' ') };
  }
  return null;
}

const CALL_RE = /([A-Za-z_]\w*)(\s*\()?/g;

function analyzeBody(body, base, lineOf) {
  const calls = new Map(), refs = new Set();
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(body))) {
    const name = m[1], idx = m.index;
    const prev = idx > 0 ? body.charCodeAt(idx - 1) : 32;
    if (prev >= 48 && prev <= 57) continue;              // tail of a number literal (0xFF, 10UL)
    if (KEYWORDS.has(name)) continue;
    let k = idx - 1;
    while (k >= 0 && body.charCodeAt(k) <= 32) k--;
    const pc = k >= 0 ? body[k] : '';
    const member = pc === '.' || (pc === '>' && body[k - 1] === '-');
    if (m[2]) {
      if (NOT_CALLS.has(name) || name.startsWith('__builtin')) continue;
      if (!member && MACRO_LIKE.test(name)) continue;    // macro invocation
      const key = (member ? '>' : '') + name;
      const e = calls.get(key);
      if (e) e.count++; else calls.set(key, { name, line: lineOf(base + idx), count: 1, ind: member });
    } else if (!member && name.length > 2 && !MACRO_LIKE.test(name)) {
      refs.add(name);
    }
  }
  return { calls: [...calls.values()], refs: [...refs] };
}

function parseStructure(text) {
  const n = text.length, lineStarts = [0];
  for (let k = 0; k < n; k++) if (text.charCodeAt(k) === 10) lineStarts.push(k + 1);
  const lineOf = (off) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const functions = [], protos = [], fileIds = new Set();
  let stmtStart = 0, depthT = 0;

  const handleStmt = (a, b) => {
    const raw = text.slice(a, b), s = raw.trim();
    if (!s || /^typedef\b/.test(s)) return;
    if (/^(static\s+)?LOG_MODULE_(REGISTER|DECLARE)\b/.test(s)) return;   // module name is not a function reference
    const p = parseProto(s);
    if (p) { protos.push({ name: p.name, signature: p.signature, line: lineOf(a + raw.length - raw.trimStart().length) }); return; }
    const re = /[A-Za-z_]\w*/g;
    let m;
    while ((m = re.exec(s))) {
      const name = m[0], i0 = m.index;
      if (name.length < 3 || KEYWORDS.has(name) || MACRO_LIKE.test(name)) continue;
      if (i0 > 0 && (s[i0 - 1] === '.' || (s[i0 - 1] === '>' && s[i0 - 2] === '-'))) continue;
      if (/\d/.test(s[i0 - 1] || '')) continue;
      fileIds.add(name);
    }
  };

  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 59) { handleStmt(stmtStart, i); stmtStart = i + 1; }
    else if (c === 123) {
      const header = text.slice(stmtStart, i);
      if (TRANSPARENT.test(header)) { depthT++; stmtStart = i + 1; continue; }
      let j = matchBrace(text, i);
      if (j === -1) j = n - 1;
      const fh = parseFuncHeader(header);
      if (fh) {
        const info = analyzeBody(text.slice(i + 1, j), i + 1, lineOf);
        functions.push({
          name: fh.name, kind: fh.kind, isStatic: fh.isStatic, isInline: fh.isInline, signature: fh.signature,
          line: lineOf(stmtStart + fh.nameIdx), endLine: lineOf(j), calls: info.calls, refs: info.refs
        });
        stmtStart = j + 1;
      }
      i = j;
    } else if (c === 125) {
      if (depthT > 0) depthT--;
      stmtStart = i + 1;
    }
  }
  return { functions, protos, fileRefs: [...fileIds] };
}

/** Parses one source file. */
function parseSource(src, path) {
  const c = clean(src);
  const st = parseStructure(c.text);
  return { path, functions: st.functions, protos: st.protos, fileRefs: st.fileRefs, macros: c.macros, includes: c.includes };
}

/* ------------------------------------------------------------------ analysis */

function parseRules(text) {
  const rules = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l[0] === '#') continue;
    const k = l.indexOf(':');
    if (k < 1) continue;
    try { rules.push({ name: l.slice(0, k).trim(), re: new RegExp(l.slice(k + 1).trim()) }); } catch (e) { /* ignore bad regex */ }
  }
  return rules;
}

function makeModuleResolver(settings) {
  const depth = settings.depth == null ? 2 : settings.depth;
  const map = [];
  for (const line of String(settings.moduleMap || '').split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l[0] === '#') continue;
    const k = l.indexOf('=');
    if (k < 1) continue;
    let prefix = l.slice(k + 1).trim().replace(/^\.?\//, '');
    if (prefix && !prefix.endsWith('/')) prefix += '/';
    map.push({ name: l.slice(0, k).trim(), prefix });
  }
  map.sort((a, b) => b.prefix.length - a.prefix.length);
  const cache = new Map();
  return (path) => {
    let r = cache.get(path);
    if (r) return r;
    for (const m of map) if (path.startsWith(m.prefix) || (path + '/') === m.prefix) { r = m.name; break; }
    if (!r) {
      if (depth === 'file') r = path;
      else {
        const dirs = path.split('/').slice(0, -1);
        if (!dirs.length) r = '(root)';
        else r = dirs.slice(0, depth === 'full' ? dirs.length : Math.min(Number(depth), dirs.length)).join('/');
      }
    }
    cache.set(path, r);
    return r;
  };
}

const isHeader = (p) => /\.(h|hh|hpp|inc)$/i.test(p);

function analyze(parsed, settings) {
  settings = settings || {};
  const moduleOf = makeModuleResolver(settings);
  const rules = parseRules(settings.externalRules != null ? settings.externalRules : DEFAULT_EXTERNAL_RULES);

  const functions = [], byName = new Map(), protoByName = new Map();
  const macros = [], macroByName = new Map(), externals = [], extMap = new Map();
  const moduleMap = new Map(), files = [], fileRefEdges = [];

  const touch = (name, path) => {
    let m = moduleMap.get(name);
    if (!m) { m = { name, files: new Set(), funcs: [] }; moduleMap.set(name, m); }
    if (path) m.files.add(path);
    return m;
  };

  for (const pf of parsed) {
    const mod = moduleOf(pf.path);
    touch(mod, pf.path);
    files.push({ path: pf.path, module: mod, functions: pf.functions.length, includes: pf.includes });
    for (const f of pf.functions) {
      const fn = {
        id: functions.length, kind: f.kind, name: f.name, file: pf.path, line: f.line, endLine: f.endLine,
        isStatic: f.isStatic, isInline: f.isInline, signature: f.signature, module: mod,
        rawCalls: f.calls, rawRefs: f.refs, out: [], indirect: [], refsOut: [], inCalls: [], refBy: []
      };
      functions.push(fn);
      moduleMap.get(mod).funcs.push(fn.id);
      let arr = byName.get(fn.name);
      if (!arr) byName.set(fn.name, arr = []);
      arr.push(fn);
    }
    for (const p of pf.protos) if (!protoByName.has(p.name)) protoByName.set(p.name, { file: pf.path, line: p.line, module: mod });
    for (const m of pf.macros) {
      if (macroByName.has(m.name)) continue;
      const sym = { id: 'm' + macros.length, kind: 'macro', name: m.name, file: pf.path, line: m.line, module: mod, callers: [], count: 0 };
      macros.push(sym); macroByName.set(m.name, sym);
    }
  }

  const findDef = (name, fromFile, fromModule) => {
    const c = byName.get(name) || byName.get('z_impl_' + name);
    if (!c) return null;
    for (const f of c) if (f.file === fromFile) return f;
    const pool = c.filter(f => !f.isStatic);
    if (pool.length) return pool.find(f => f.module === fromModule) || pool[0];
    return c.find(f => f.isStatic && isHeader(f.file)) || null;
  };
  const classify = (name) => { for (const r of rules) if (r.re.test(name)) return r.name; return null; };
  const ext = (name, type, group) => {
    let s = extMap.get(name);
    if (!s) {
      s = { id: 'x' + externals.length, kind: 'external', name, type, group, module: group, callers: [], count: 0 };
      extMap.set(name, s); externals.push(s);
    }
    return s;
  };

  for (const fn of functions) {
    for (const c of fn.rawCalls) {
      if (c.ind) { fn.indirect.push({ name: c.name, line: c.line, count: c.count }); continue; }
      const base = { name: c.name, line: c.line, count: c.count };
      const def = findDef(c.name, fn.file, fn.module);
      if (def) {
        fn.out.push(Object.assign(base, { t: 'fn', to: def.id, module: def.module }));
        def.inCalls.push({ from: fn.id, line: c.line });
        continue;
      }
      const mac = macroByName.get(c.name);
      if (mac) { fn.out.push(Object.assign(base, { t: 'macro', to: mac.id, module: mac.module })); mac.callers.push(fn.id); mac.count += c.count; continue; }
      const group = classify(c.name);
      const proto = protoByName.get(c.name);
      let s, t;
      if (group) { s = ext(c.name, 'ext', group); t = 'ext'; }
      else if (proto) { s = ext(c.name, 'decl', proto.module); s.file = proto.file; s.line = proto.line; t = 'decl'; }
      else { s = ext(c.name, 'unk', 'Unclassified'); t = 'unk'; }
      if (proto && !s.file) { s.file = proto.file; s.line = proto.line; }
      s.callers.push(fn.id); s.count += c.count;
      fn.out.push(Object.assign(base, { t, to: s.id, module: s.module }));
    }
    fn.out.sort((a, b) => a.line - b.line);
    fn.indirect.sort((a, b) => a.line - b.line);
    for (const r of fn.rawRefs) {
      const def = findDef(r, fn.file, fn.module);
      if (def && def.id !== fn.id) { fn.refsOut.push(def.id); def.refBy.push({ from: fn.id }); }
    }
  }
  for (const pf of parsed) {
    const mod = moduleOf(pf.path);
    for (const id of pf.fileRefs) {
      const def = findDef(id, pf.path, mod);
      if (def) { fileRefEdges.push({ file: pf.path, module: mod, to: def.id }); def.refBy.push({ file: pf.path, scope: true }); }
    }
  }
  for (const fn of functions) { delete fn.rawCalls; delete fn.rawRefs; }

  const symMap = new Map();
  for (const m of macros) symMap.set(m.id, m);
  for (const x of externals) symMap.set(x.id, x);
  const modules = [...moduleMap.values()].map(m => ({ name: m.name, files: [...m.files], funcs: m.funcs }));

  let callEdges = 0, statics = 0;
  for (const fn of functions) { if (fn.isStatic) statics++; for (const o of fn.out) if (o.t === 'fn') callEdges++; }
  const extGroups = new Map();
  for (const x of externals) {
    let g = extGroups.get(x.group);
    if (!g) extGroups.set(x.group, g = { name: x.group, apis: 0, calls: 0 });
    g.apis++; g.calls += x.count;
  }

  return {
    functions, externals, macros, modules, files, fileRefEdges,
    sym: (id) => typeof id === 'number' ? functions[id] : symMap.get(id),
    stats: { files: files.length, functions: functions.length, statics, globals: functions.length - statics,
             modules: modules.length, callEdges, externalApis: externals.length, macros: macros.length,
             extGroups: [...extGroups.values()].sort((a, b) => b.calls - a.calls) }
  };
}

/* ------------------------------------------------------------------ module graph */

function buildModuleGraph(model, o) {
  o = Object.assign({ externals: true, unclassified: false, refs: true, hideIsolated: true }, o);
  const nodes = new Map(), edges = new Map();
  const node = (name, external) => {
    let n = nodes.get(name);
    if (!n) { n = { id: name, name, external, funcCount: 0, fileCount: 0, apiMap: new Map(), api: [] }; nodes.set(name, n); }
    return n;
  };
  for (const m of model.modules) { const n = node(m.name, false); n.funcCount = m.funcs.length; n.fileCount = m.files.length; }

  const add = (srcMod, dstMod, dstExternal, dstName, dstFn, srcFn, kind, count) => {
    if (srcMod === dstMod) return;
    node(srcMod, false);
    const dn = node(dstMod, dstExternal);
    const key = srcMod + '\u0001' + dstMod;
    let e = edges.get(key);
    if (!e) { e = { key, from: srcMod, to: dstMod, calls: 0, refs: 0, items: [], apiSet: new Set(), _ix: new Map() }; edges.set(key, e); }
    const ik = srcFn + '|' + dstName + '|' + kind;
    let it = e._ix.get(ik);
    if (!it) { it = { srcFn, dstName, dstFn, kind, count: 0 }; e._ix.set(ik, it); e.items.push(it); }
    it.count += count;
    if (kind === 'call') e.calls += count; else e.refs += count;
    e.apiSet.add(dstName);
    let a = dn.apiMap.get(dstName);
    if (!a) { a = { name: dstName, fnId: dstFn, users: new Set(), calls: 0 }; dn.apiMap.set(dstName, a); }
    a.users.add(srcMod); a.calls += count;
  };

  for (const fn of model.functions) {
    for (const c of fn.out) {
      let dstMod, ext = false;
      if (c.t === 'fn') dstMod = c.module;
      else if (c.t === 'ext') { dstMod = c.module; ext = true; }
      else if (c.t === 'decl') dstMod = c.module;
      else if (c.t === 'unk') { if (!o.unclassified) continue; dstMod = 'Unclassified'; ext = true; }
      else continue;
      if (ext && !o.externals) continue;
      add(fn.module, dstMod, ext, c.name, c.t === 'fn' ? c.to : null, fn.id, 'call', c.count);
    }
    if (o.refs) for (const to of fn.refsOut) {
      const t = model.functions[to];
      add(fn.module, t.module, false, t.name, t.id, fn.id, 'ref', 1);
    }
  }
  if (o.refs) for (const r of model.fileRefEdges) {
    const t = model.functions[r.to];
    add(r.module, t.module, false, t.name, t.id, null, 'ref', 1);
  }

  const connected = new Set();
  for (const e of edges.values()) { connected.add(e.from); connected.add(e.to); }
  const outNodes = [];
  for (const n of nodes.values()) {
    if (o.hideIsolated && !connected.has(n.id)) continue;
    n.api = [...n.apiMap.values()].sort((a, b) => b.users.size - a.users.size || b.calls - a.calls || a.name.localeCompare(b.name));
    n.api.forEach(a => { a.usersList = [...a.users]; });
    outNodes.push(n);
  }
  const outEdges = [...edges.values()].map(e => { e.apis = [...e.apiSet]; delete e.apiSet; delete e._ix; return e; });
  return { nodes: outNodes, edges: outEdges };
}

const api = { parseSource, analyze, buildModuleGraph, parseRules, makeModuleResolver, clean, DEFAULT_EXTERNAL_RULES };
root.NcsCore = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
