/* Kconfig Explorer
 * Parses Zephyr / NCS .config files entirely client-side and renders:
 *  - a folder-style tree, grouped by "_"-separated tokens in CONFIG_* names
 *  - a flat list of every symbol set to =y
 *  - a flat, sortable table of every symbol found
 * No data ever leaves the browser.
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  let symbols = [];     // flat list of parsed symbols
  let tree = null;       // trie built from symbol names
  let activeTab = "tree";
  let currentQuery = "";
  let allSort = { key: "name", dir: 1 };

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------

  const el = {
    fileInput: document.getElementById("fileInput"),
    sampleBtn: document.getElementById("sampleBtn"),
    clearBtn: document.getElementById("clearBtn"),
    fileName: document.getElementById("fileName"),
    dropHint: document.getElementById("dropHint"),
    statsBar: document.getElementById("statsBar"),
    toolbar: document.getElementById("toolbar"),
    tabs: document.getElementById("tabs"),
    searchInput: document.getElementById("searchInput"),
    searchClear: document.getElementById("searchClear"),
    treeView: document.getElementById("treeView"),
    treeRoot: document.getElementById("treeRoot"),
    treeEmpty: document.getElementById("treeEmpty"),
    enabledView: document.getElementById("enabledView"),
    enabledList: document.getElementById("enabledList"),
    enabledCount: document.getElementById("enabledCount"),
    enabledEmpty: document.getElementById("enabledEmpty"),
    exportEnabled: document.getElementById("exportEnabled"),
    topLevelOnly: document.getElementById("topLevelOnly"),
    allView: document.getElementById("allView"),
    allTableBody: document.getElementById("allTableBody"),
    allCount: document.getElementById("allCount"),
    allEmpty: document.getElementById("allEmpty"),
    detailsPanel: document.getElementById("detailsPanel"),
    detailsBody: document.getElementById("detailsBody"),
    detailsClose: document.getElementById("detailsClose"),
  };

  // ---------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------

  const UNSET_RE = /^#\s*(CONFIG_[A-Za-z0-9_]+)\s+is not set\s*$/;
  const SET_RE = /^(CONFIG_[A-Za-z0-9_]+)=(.*)$/;

  function parseConfig(text) {
    const lines = text.split(/\r?\n/);
    const out = [];

    lines.forEach((rawLine, idx) => {
      const line = rawLine.trim();
      if (!line) return;

      if (line.startsWith("#")) {
        const m = line.match(UNSET_RE);
        if (m) {
          out.push({
            name: m[1],
            rawValue: null,
            value: "n",
            type: "bool",
            set: false,
            lineNumber: idx + 1,
            raw: rawLine,
          });
        }
        return; // ordinary comment, ignore
      }

      const m = line.match(SET_RE);
      if (!m) return;

      const name = m[1];
      const rawVal = m[2];
      let type = "other";
      let value = rawVal;

      if (rawVal === "y" || rawVal === "n") {
        type = "bool";
        value = rawVal;
      } else if (/^".*"$/.test(rawVal)) {
        type = "string";
        value = rawVal
          .slice(1, -1)
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      } else if (/^0x[0-9a-fA-F]+$/.test(rawVal) || /^-?\d+$/.test(rawVal)) {
        type = "number";
        value = rawVal;
      }

      out.push({
        name,
        rawValue: rawVal,
        value,
        type,
        set: true,
        lineNumber: idx + 1,
        raw: rawLine,
      });
    });

    return out;
  }

  // ---------------------------------------------------------------------
  // Tree building
  // ---------------------------------------------------------------------

  function buildTree(symbolList) {
    const root = { name: "", fullKey: "", children: {}, symbol: null };

    symbolList.forEach((sym) => {
      const rest = sym.name.replace(/^CONFIG_/, "");
      const tokens = rest.split("_").filter(Boolean);
      let node = root;
      const path = [];
      tokens.forEach((tok) => {
        path.push(tok);
        if (!node.children[tok]) {
          node.children[tok] = {
            name: tok,
            fullKey: "CONFIG_" + path.join("_"),
            children: {},
            symbol: null,
          };
        }
        node = node.children[tok];
      });
      node.symbol = sym;
    });

    computeCounts(root);
    return root;
  }

  function computeCounts(node) {
    let total = node.symbol ? 1 : 0;
    let yCount = node.symbol && node.symbol.value === "y" ? 1 : 0;

    Object.keys(node.children).forEach((k) => {
      const child = node.children[k];
      computeCounts(child);
      total += child.totalCount;
      yCount += child.yCount;
    });

    node.totalCount = total;
    node.yCount = yCount;
  }

  // ---------------------------------------------------------------------
  // Filtering (search)
  // ---------------------------------------------------------------------

  // Marks node.visible = true for nodes whose fullKey matches the query,
  // or that have a visible descendant. Returns whether node is visible.
  function markVisible(node, query) {
    let selfMatch = !query || node.fullKey.toLowerCase().includes(query);
    let childVisible = false;

    Object.keys(node.children).forEach((k) => {
      const child = node.children[k];
      const v = markVisible(child, query);
      childVisible = childVisible || v;
    });

    node.visible = selfMatch || childVisible;
    node.selfMatch = selfMatch;
    return node.visible;
  }

  // ---------------------------------------------------------------------
  // Rendering: Tree view
  // ---------------------------------------------------------------------

  function highlight(text, query) {
    if (!query) return document.createTextNode(text);
    const idx = text.toLowerCase().indexOf(query);
    if (idx === -1) return document.createTextNode(text);
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(text.slice(0, idx)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(idx, idx + query.length);
    frag.appendChild(mark);
    frag.appendChild(document.createTextNode(text.slice(idx + query.length)));
    return frag;
  }

  function valuePill(sym) {
    const pill = document.createElement("span");
    pill.className = "val-pill " + (sym.type === "bool" ? sym.value : sym.type);
    if (sym.type === "bool") {
      pill.textContent = "=" + sym.value;
    } else if (sym.type === "string") {
      pill.textContent = '="' + sym.value + '"';
    } else {
      pill.textContent = "=" + sym.value;
    }
    return pill;
  }

  function leafDotClass(sym) {
    if (sym.type === "bool") return sym.value === "y" ? "on" : "off";
    return "other";
  }

  function renderTreeChildren(node, container, query) {
    const keys = Object.keys(node.children).sort((a, b) => a.localeCompare(b));
    keys.forEach((k) => {
      const child = node.children[k];
      if (query && !child.visible) return;

      const li = document.createElement("li");
      li.className = "tree-item";

      const hasChildren = Object.keys(child.children).length > 0;

      if (!hasChildren) {
        li.appendChild(renderLeafRow(child, query));
      } else {
        li.appendChild(renderFolderRow(child, query));
      }

      container.appendChild(li);
    });
  }

  function renderFolderRow(node, query) {
    const details = document.createElement("details");
    details.className = "tree-node";
    // auto-expand when filtering, or for the first couple of levels by default
    if (query) details.open = true;

    const summary = document.createElement("summary");
    const row = document.createElement("div");
    row.className = "tree-row";

    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    row.appendChild(chevron);

    const icon = document.createElement("span");
    icon.className = "node-icon folder";
    icon.textContent = "\u25A0"; // filled square as a simple "module" glyph
    icon.style.fontSize = "8px";
    row.appendChild(icon);

    const name = document.createElement("span");
    name.className = "node-name";
    const b = document.createElement("b");
    b.appendChild(highlight(node.name, query));
    name.appendChild(b);
    row.appendChild(name);

    const badgeWrap = document.createElement("span");
    badgeWrap.className = "node-badge";

    if (node.symbol) {
      badgeWrap.appendChild(valuePill(node.symbol));
    }

    const pill = document.createElement("span");
    pill.className = "count-pill";
    const yPart = node.yCount > 0 ? `, <span class="y-count">${node.yCount} on</span>` : "";
    pill.innerHTML = `${node.totalCount} sym${yPart}`;
    badgeWrap.appendChild(pill);

    row.appendChild(badgeWrap);
    summary.appendChild(row);
    details.appendChild(summary);

    if (node.symbol) {
      row.style.cursor = "pointer";
      row.title = "Click to view " + node.fullKey + " details (this node also has its own value)";
      row.addEventListener("click", (e) => {
        // if the click is on the chevron area toggling is fine; still show details too
        showDetails(node.symbol);
      });
    }

    const ul = document.createElement("ul");
    ul.className = "tree-children";
    renderTreeChildren(node, ul, query);
    details.appendChild(ul);

    return details;
  }

  function renderLeafRow(node, query) {
    const sym = node.symbol;
    const row = document.createElement("div");
    row.className = "tree-row tree-leaf";
    row.tabIndex = 0;

    const dot = document.createElement("span");
    dot.className = "node-icon leaf-dot " + leafDotClass(sym);
    row.appendChild(dot);

    const name = document.createElement("span");
    name.className = "node-name";
    name.appendChild(highlight(node.name, query));
    row.appendChild(name);

    row.appendChild(valuePill(sym));

    row.addEventListener("click", () => showDetails(sym));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        showDetails(sym);
      }
    });

    return row;
  }

  function renderTree() {
    el.treeRoot.innerHTML = "";
    const query = currentQuery;

    if (query) {
      markVisible(tree, query);
      if (!tree.visible) {
        el.treeEmpty.hidden = false;
        el.treeEmpty.querySelector("span").textContent = query;
        return;
      }
    }
    el.treeEmpty.hidden = true;
    renderTreeChildren(tree, el.treeRoot, query);
  }

  // ---------------------------------------------------------------------
  // Rendering: Enabled (=y) view
  // ---------------------------------------------------------------------

  // True for CONFIG_NAME where NAME itself contains no further "_" —
  // i.e. exactly one underscore in the whole symbol, right after CONFIG.
  // Excludes sub-symbols like CONFIG_BT_PERIPHERAL.
  function isTopLevelSymbolName(name) {
    return !name.replace(/^CONFIG_/, "").includes("_");
  }

  function getEnabledList(query, topLevelOnly) {
    return symbols
      .filter((s) => s.value === "y")
      .filter((s) => !topLevelOnly || isTopLevelSymbolName(s.name))
      .filter((s) => !query || s.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function renderEnabled() {
    const query = currentQuery;
    const topLevelOnly = el.topLevelOnly.checked;
    const enabled = getEnabledList(query, topLevelOnly);

    el.enabledCount.textContent = `${enabled.length} symbol${enabled.length === 1 ? "" : "s"} set to =y`;
    el.enabledList.innerHTML = "";
    el.enabledEmpty.hidden = enabled.length !== 0;

    enabled.forEach((sym) => {
      const li = document.createElement("li");
      li.className = "flat-row";
      li.tabIndex = 0;

      const dot = document.createElement("span");
      dot.className = "dot";
      li.appendChild(dot);

      const name = document.createElement("span");
      name.className = "name";
      name.appendChild(highlight(sym.name, query));
      li.appendChild(name);

      li.addEventListener("click", () => showDetails(sym));
      el.enabledList.appendChild(li);
    });
  }

  function exportEnabledList() {
    // Exports exactly what's currently shown (respects the search filter
    // and the "top-level symbols only" checkbox).
    const enabled = getEnabledList(currentQuery, el.topLevelOnly.checked).map(
      (s) => s.name + "=y"
    );
    const blob = new Blob([enabled.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "enabled-config-symbols.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------------
  // Rendering: All symbols view
  // ---------------------------------------------------------------------

  function renderAll() {
    const query = currentQuery;
    let list = symbols.filter(
      (s) => !query || s.name.toLowerCase().includes(query)
    );

    const { key, dir } = allSort;
    list = list.slice().sort((a, b) => {
      let av, bv;
      if (key === "name") { av = a.name; bv = b.name; }
      else if (key === "value") { av = String(a.value); bv = String(b.value); }
      else { av = a.lineNumber; bv = b.lineNumber; }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    el.allCount.textContent = `${list.length} of ${symbols.length} symbols`;
    el.allTableBody.innerHTML = "";
    el.allEmpty.hidden = list.length !== 0;

    list.forEach((sym) => {
      const tr = document.createElement("tr");

      const tdName = document.createElement("td");
      tdName.className = "name";
      tdName.appendChild(highlight(sym.name, query));
      tr.appendChild(tdName);

      const tdVal = document.createElement("td");
      tdVal.appendChild(valuePill(sym));
      tr.appendChild(tdVal);

      const tdType = document.createElement("td");
      tdType.textContent = sym.type;
      tdType.style.color = "var(--text-faint)";
      tr.appendChild(tdType);

      const tdLine = document.createElement("td");
      tdLine.className = "line";
      tdLine.textContent = sym.lineNumber;
      tr.appendChild(tdLine);

      tr.addEventListener("click", () => showDetails(sym));
      el.allTableBody.appendChild(tr);
    });
  }

  // ---------------------------------------------------------------------
  // Details panel
  // ---------------------------------------------------------------------

  function showDetails(sym) {
    el.detailsBody.innerHTML = "";
    const h3 = document.createElement("h3");
    h3.textContent = sym.name;
    el.detailsBody.appendChild(h3);

    const dl = document.createElement("dl");
    const rows = [
      ["Value", sym.type === "string" ? `"${sym.value}"` : String(sym.value)],
      ["Type", sym.type],
      ["Status", sym.set ? "explicitly set" : "explicitly unset"],
      ["Line", "#" + sym.lineNumber],
    ];
    rows.forEach(([dt, dd]) => {
      const dtEl = document.createElement("dt");
      dtEl.textContent = dt;
      const ddEl = document.createElement("dd");
      ddEl.textContent = dd;
      dl.appendChild(dtEl);
      dl.appendChild(ddEl);
    });
    el.detailsBody.appendChild(dl);

    const raw = document.createElement("div");
    raw.className = "raw-line";
    raw.textContent = sym.raw;
    el.detailsBody.appendChild(raw);

    el.detailsPanel.hidden = false;
  }

  el.detailsClose.addEventListener("click", () => {
    el.detailsPanel.hidden = true;
  });

  // ---------------------------------------------------------------------
  // Stats bar
  // ---------------------------------------------------------------------

  function renderStats() {
    const total = symbols.length;
    const yCount = symbols.filter((s) => s.value === "y").length;
    const nCount = symbols.filter((s) => s.type === "bool" && s.value === "n").length;
    const strCount = symbols.filter((s) => s.type === "string").length;
    const numCount = symbols.filter((s) => s.type === "number").length;

    const chips = [
      { val: total, lbl: "Symbols", cls: "" },
      { val: yCount, lbl: "Set to =y", cls: "y" },
      { val: nCount, lbl: "Off / n", cls: "n" },
      { val: strCount, lbl: "Strings", cls: "str" },
      { val: numCount, lbl: "Numbers", cls: "" },
    ];

    el.statsBar.innerHTML = "";
    chips.forEach((c) => {
      const chip = document.createElement("div");
      chip.className = "stat-chip " + c.cls;
      chip.innerHTML = `<span class="val">${c.val}</span><span class="lbl">${c.lbl}</span>`;
      el.statsBar.appendChild(chip);
    });
    el.statsBar.hidden = false;
  }

  // ---------------------------------------------------------------------
  // View orchestration
  // ---------------------------------------------------------------------

  function renderActiveView() {
    if (activeTab === "tree") renderTree();
    else if (activeTab === "enabled") renderEnabled();
    else if (activeTab === "all") renderAll();
  }

  function setActiveTab(tab) {
    activeTab = tab;
    [...el.tabs.querySelectorAll(".tab")].forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    el.treeView.hidden = tab !== "tree";
    el.enabledView.hidden = tab !== "enabled";
    el.allView.hidden = tab !== "all";
    renderActiveView();
  }

  el.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    setActiveTab(btn.dataset.tab);
  });

  el.searchInput.addEventListener("input", () => {
    currentQuery = el.searchInput.value.trim().toLowerCase();
    el.searchClear.hidden = currentQuery.length === 0;
    renderActiveView();
  });

  el.searchClear.addEventListener("click", () => {
    el.searchInput.value = "";
    currentQuery = "";
    el.searchClear.hidden = true;
    renderActiveView();
  });

  el.allView.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      if (allSort.key === key) {
        allSort.dir *= -1;
      } else {
        allSort = { key, dir: 1 };
      }
      el.allView.querySelectorAll(".sort-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderAll();
    });
  });

  el.exportEnabled.addEventListener("click", exportEnabledList);

  el.topLevelOnly.addEventListener("change", () => {
    if (activeTab === "enabled") renderEnabled();
  });

  // ---------------------------------------------------------------------
  // Loading a file
  // ---------------------------------------------------------------------

  function loadConfigText(text, displayName) {
    symbols = parseConfig(text);
    tree = buildTree(symbols);
    currentQuery = "";
    el.searchInput.value = "";
    el.searchClear.hidden = true;

    el.fileName.textContent = displayName ? `Loaded: ${displayName} (${symbols.length} symbols)` : "";
    el.dropHint.hidden = true;
    el.clearBtn.hidden = false;
    el.toolbar.hidden = false;

    renderStats();
    setActiveTab("tree");
  }

  function handleFile(file) {
    const reader = new FileReader();
    reader.onload = () => loadConfigText(String(reader.result), file.name);
    reader.onerror = () => {
      alert("Could not read that file. Please try again.");
    };
    reader.readAsText(file);
  }

  el.fileInput.addEventListener("change", () => {
    const file = el.fileInput.files && el.fileInput.files[0];
    if (file) handleFile(file);
  });

  ["dragenter", "dragover"].forEach((evt) => {
    el.dropHint.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropHint.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    el.dropHint.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropHint.classList.remove("drag-over");
    });
  });
  el.dropHint.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  // Also allow dropping anywhere on the page once a file is loaded, or before.
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    if (e.target.closest("#dropHint")) return; // already handled above
    e.preventDefault();
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  el.clearBtn.addEventListener("click", () => {
    symbols = [];
    tree = null;
    el.fileInput.value = "";
    el.fileName.textContent = "";
    el.clearBtn.hidden = true;
    el.toolbar.hidden = true;
    el.statsBar.hidden = true;
    el.dropHint.hidden = false;
    el.detailsPanel.hidden = true;
  });

  el.sampleBtn.addEventListener("click", () => {
    loadConfigText(SAMPLE_CONFIG, "sample.config");
  });

  // ---------------------------------------------------------------------
  // Sample fixture — representative NCS / Zephyr .config content, so the
  // tool can be tried immediately without a real build directory.
  // ---------------------------------------------------------------------

  const SAMPLE_CONFIG = `#
# Automatically generated file; DO NOT EDIT.
# Zephyr/NCS Kernel Configuration
#
CONFIG_BOARD="nrf52840dk_nrf52840"
CONFIG_SOC="nrf52840"
CONFIG_ARCH="arm"

#
# Bluetooth
#
CONFIG_BT=y
CONFIG_BT_PERIPHERAL=y
CONFIG_BT_CENTRAL=n
CONFIG_BT_GATT_CLIENT=y
CONFIG_BT_GATT_DYNAMIC_DB=y
CONFIG_BT_DEVICE_NAME="NCS_Sample_Device"
CONFIG_BT_MAX_CONN=4
CONFIG_BT_LL_SW_SPLIT=y
CONFIG_BT_CTLR_TX_PWR_PLUS_8=y
# CONFIG_BT_HCI_RAW is not set
# CONFIG_BT_OBSERVER is not set

#
# Logging
#
CONFIG_LOG=y
CONFIG_LOG_DEFAULT_LEVEL=3
CONFIG_LOG_MODE_DEFERRED=y
CONFIG_LOG_BACKEND_UART=y
# CONFIG_LOG_BACKEND_RTT is not set
CONFIG_LOG_BUFFER_SIZE=4096

#
# Main thread / kernel
#
CONFIG_MAIN_STACK_SIZE=2048
CONFIG_SYSTEM_WORKQUEUE_STACK_SIZE=1024
CONFIG_HEAP_MEM_POOL_SIZE=8192
CONFIG_MULTITHREADING=y

#
# Power management
#
CONFIG_PM=y
CONFIG_PM_DEVICE=y
# CONFIG_PM_DEVICE_RUNTIME is not set

#
# Flash / storage
#
CONFIG_FLASH=y
CONFIG_FLASH_MAP=y
CONFIG_NVS=y
CONFIG_SETTINGS=y
CONFIG_SETTINGS_NVS=y

#
# Networking
#
# CONFIG_NETWORKING is not set

#
# Debug
#
CONFIG_DEBUG=n
CONFIG_ASSERT=y
CONFIG_STACK_SENTINEL=y
`;

})();
