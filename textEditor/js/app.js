import { PaneController } from "./pane.js";
import { FileManager } from "./file-manager.js";
import { languageFromFilename, languageLabel } from "./syntax.js";

const $ = id => document.getElementById(id);

const fileManager = new FileManager();

let focusedPaneId = 0;
let splitActive = false;
let pendingClose = null; // { paneId, docId }

// ---------------------------------------------------------------------
// Pane setup
// ---------------------------------------------------------------------

// `panes` is populated below. Handlers only run in response to later user
// interaction (never synchronously during PaneController construction),
// but we still declare it with `let` first and build it in two steps so
// nothing can ever observe it mid-initialization.
let panes = [];

const paneHandlers = {
  onStatusChange: paneId => refreshStatusBar(paneId),
  onFocus: paneId => (focusedPaneId = paneId),
  onRequestClose: (paneId, doc) => showCloseModal(paneId, doc),
  onMove: (paneId, docId) => moveTab(paneId, docId),
  onDropTab: (paneId, docId, sourcePaneId) => moveTab(sourcePaneId, docId, paneId),
  onTabsChanged: () => {}
};

panes = [
  new PaneController(0, $("paneMount0"), paneHandlers),
  new PaneController(1, $("paneMount1"), paneHandlers)
];

function getPane(id) {
  return panes[id];
}

function getFocusedPane() {
  return panes[focusedPaneId] || panes[0];
}

function allDocuments() {
  return [...panes[0].tabs.documents, ...panes[1].tabs.documents];
}

function findDocByPath(path) {
  for (const pane of panes) {
    const doc = pane.tabs.documents.find(d => d.path && d.path === path);
    if (doc) return { pane, doc };
  }
  return null;
}

// ---------------------------------------------------------------------
// Status bar (shared footer reflects the focused pane)
// ---------------------------------------------------------------------

function refreshStatusBar(paneId) {
  if (paneId !== focusedPaneId) return;
  const pane = getFocusedPane();
  if (!pane) return;
  const doc = pane.getActive();
  if (!doc) {
    $("fileStatus").textContent = "No file open";
    $("languageStatus").textContent = "Plain Text";
    $("positionStatus").textContent = "Ln 1, Col 1";
    return;
  }
  const pos = pane.editor.getCursor();
  $("fileStatus").textContent = `${doc.modified ? "● " : ""}${doc.name}`;
  $("languageStatus").textContent = languageLabel(doc.language);
  $("positionStatus").textContent = `Ln ${pos.line}, Col ${pos.col}`;
}

// ---------------------------------------------------------------------
// Close (unsaved changes) modal — pane-aware
// ---------------------------------------------------------------------

function showCloseModal(paneId, doc) {
  pendingClose = { paneId, docId: doc.id };
  $("closeModalMessage").textContent =
    `Save changes to "${doc.name}" before closing?`;
  $("closeModal").classList.remove("hidden");
  $("closeSave").focus();
}

function hideCloseModal() {
  pendingClose = null;
  $("closeModal").classList.add("hidden");
}

async function handleCloseSave() {
  const pending = pendingClose;
  hideCloseModal();
  if (!pending) return;
  const pane = getPane(pending.paneId);
  const doc = pane.tabs.documents.find(d => d.id === pending.docId);
  if (!doc) return;
  try {
    await fileManager.save(doc);
    pane.tabs.closeImmediately(doc.id);
  } catch (e) {
    if (e.name !== "AbortError") alert(`Could not save file: ${e.message}`);
  }
}

function handleCloseDiscard() {
  const pending = pendingClose;
  hideCloseModal();
  if (!pending) return;
  getPane(pending.paneId).tabs.closeImmediately(pending.docId);
}

// ---------------------------------------------------------------------
// Split view
// ---------------------------------------------------------------------

function setSplit(active) {
  splitActive = active;
  document.body.classList.toggle("split-active", active);
  $("splitButton").classList.toggle("active", active);
  $("paneMount1").hidden = !active;
  $("paneSplitter").hidden = !active;
  $("paneMount0").style.flex = "";
  $("paneMount1").style.flex = "";
  if (!active) {
    // Fold everything back into pane 0 so no open document is lost.
    for (const doc of [...panes[1].tabs.documents]) {
      panes[1].tabs.closeImmediately(doc.id);
      panes[0].addDocument(doc);
    }
    focusedPaneId = 0;
  }
  refreshStatusBar(focusedPaneId);
}

function toggleSplit() {
  setSplit(!splitActive);
}

function moveTab(fromPaneId, docId, toPaneId) {
  const fromPane = getPane(fromPaneId);
  if (!fromPane) return;
  const doc = fromPane.tabs.documents.find(d => d.id === docId);
  if (!doc) return;

  const targetId = toPaneId ?? (fromPaneId === 0 ? 1 : 0);
  if (targetId === fromPaneId) return;

  if (!splitActive) setSplit(true);

  const toPane = getPane(targetId);
  focusedPaneId = targetId;
  fromPane.tabs.closeImmediately(docId);
  toPane.addDocument(doc);
  toPane.editor.focus();
}

// Drag the splitter to resize the two panes.
(() => {
  const splitter = $("paneSplitter");
  const container = $("panes");
  let dragging = false;

  splitter.addEventListener("mousedown", e => {
    dragging = true;
    splitter.classList.add("dragging");
    e.preventDefault();
  });

  window.addEventListener("mousemove", e => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const ratio = Math.min(0.85, Math.max(0.15, (e.clientX - rect.left) / rect.width));
    $("paneMount0").style.flex = `${ratio} 1 0%`;
    $("paneMount1").style.flex = `${1 - ratio} 1 0%`;
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
  });
})();

// ---------------------------------------------------------------------
// Document actions (operate on the currently focused pane)
// ---------------------------------------------------------------------

function newDocument() {
  const number = allDocuments().filter(d => d.name.startsWith("Untitled")).length + 1;
  const doc = {
    id: crypto.randomUUID(),
    name: `Untitled-${number}.c`,
    path: "",
    content: "",
    language: "c",
    modified: false,
    handle: null
  };
  const pane = getFocusedPane();
  pane.addDocument(doc);
  pane.editor.focus();
}

async function openFiles(files) {
  for (const file of files) {
    const doc = await fileManager.readFile(file);
    doc.language = languageFromFilename(doc.name);
    const existing = doc.path && findDocByPath(doc.path);
    if (existing) {
      focusedPaneId = existing.pane.id;
      existing.pane.activate(existing.doc.id);
    } else {
      const pane = getFocusedPane();
      pane.addDocument(doc);
    }
  }
  getFocusedPane().editor.focus();
}

async function openSingle() {
  try {
    if (window.showOpenFilePicker) {
      const doc = await fileManager.openWithHandle();
      if (doc) {
        doc.language = languageFromFilename(doc.name);
        const pane = getFocusedPane();
        pane.addDocument(doc);
        pane.editor.focus();
      }
    } else {
      $("fileInput").click();
    }
  } catch (e) {
    if (e.name !== "AbortError") alert(`Could not open file: ${e.message}`);
  }
}

async function save() {
  const pane = getFocusedPane();
  const doc = pane.getActive();
  if (!doc) return newDocument();
  try {
    await fileManager.save(doc);
    pane.tabs.render();
    refreshStatusBar(pane.id);
  } catch (e) {
    if (e.name !== "AbortError") alert(`Could not save file: ${e.message}`);
  }
}

async function saveAs() {
  const pane = getFocusedPane();
  const doc = pane.getActive();
  if (!doc) return newDocument();
  try {
    await fileManager.saveAs(doc);
    doc.language = languageFromFilename(doc.name);
    pane.tabs.render();
    refreshStatusBar(pane.id);
  } catch (e) {
    if (e.name !== "AbortError") alert(`Could not save file: ${e.message}`);
  }
}

function formatActiveDocument() {
  getFocusedPane().formatActiveDocument();
}

function openSearch() {
  getFocusedPane().openSearch();
}

function closeSearch() {
  getFocusedPane().closeSearch();
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

document.querySelectorAll("[data-action]").forEach(button => {
  button.addEventListener("click", async () => {
    const action = button.dataset.action;
    if (action === "new") newDocument();
    if (action === "open") await openSingle();
    if (action === "open-folder") $("folderInput").click();
    if (action === "save") await save();
    if (action === "save-as") await saveAs();
    if (action === "search") openSearch();
    if (action === "format") formatActiveDocument();
    if (action === "split") toggleSplit();
  });
});

$("fileInput").addEventListener("change", e => openFiles([...e.target.files]));
$("folderInput").addEventListener("change", e => openFiles([...e.target.files]));

$("closeSave").addEventListener("click", handleCloseSave);
$("closeDiscard").addEventListener("click", handleCloseDiscard);
$("closeCancel").addEventListener("click", hideCloseModal);
$("closeModal").addEventListener("click", e => {
  if (e.target === $("closeModal")) hideCloseModal();
});

$("themeButton").addEventListener("click", () => {
  document.documentElement.classList.toggle("light");
  localStorage.setItem("editorTheme", document.documentElement.classList.contains("light") ? "light" : "dark");
});

if (localStorage.getItem("editorTheme") === "light") {
  document.documentElement.classList.add("light");
}

document.addEventListener("keydown", async e => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) {
    if (e.key === "Escape") {
      if (!$("closeModal").classList.contains("hidden")) hideCloseModal();
      else if (getFocusedPane().isSearchOpen()) closeSearch();
    }
    return;
  }

  if (e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (e.shiftKey) await saveAs(); else await save();
  } else if (e.key.toLowerCase() === "o") {
    e.preventDefault();
    await openSingle();
  } else if (e.key.toLowerCase() === "n") {
    e.preventDefault();
    newDocument();
  } else if (e.key.toLowerCase() === "f") {
    e.preventDefault();
    if (e.shiftKey) formatActiveDocument(); else openSearch();
  } else if (e.key.toLowerCase() === "w") {
    e.preventDefault();
    const doc = getFocusedPane().getActive();
    if (doc) getFocusedPane().tabs.close(doc.id);
  } else if (e.key === "\\") {
    e.preventDefault();
    toggleSplit();
  }
});

window.addEventListener("beforeunload", e => {
  if (allDocuments().some(d => d.modified)) {
    e.preventDefault();
    e.returnValue = "";
  }
});

newDocument();
