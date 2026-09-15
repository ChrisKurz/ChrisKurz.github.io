import { EditorView } from "./editor.js";
import { TabManager } from "./tabs.js";
import { SearchController } from "./search.js";
import { languageFromFilename } from "./syntax.js";

// A Pane bundles everything needed for one column of the split view: its
// own tab strip, its own search/replace panel and its own EditorView. Two
// panes can be mounted side by side so the user can view/edit two files
// (or the same file twice) at once.
export class PaneController {
  constructor(id, host, handlers) {
    this.id = id;
    this.handlers = handlers; // onStatusChange, onFocus, onRequestClose, onMove, onDropTab, onTabsChanged
    this.suppressChange = false;

    this.el = host;
    this.el.classList.add("pane");
    this.el.dataset.pane = String(id);

    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "tabs";
    this.tabsEl.setAttribute("role", "tablist");
    this.tabsEl.setAttribute("aria-label", "Open files");

    this.searchPanelEl = document.createElement("div");
    this.searchPanelEl.className = "search-panel hidden";
    this.searchPanelEl.innerHTML = `
      <div class="search-row">
        <input type="text" class="search-input" placeholder="Find" autocomplete="off">
        <input type="text" class="replace-input" placeholder="Replace">
        <button type="button" class="prev-match">Previous</button>
        <button type="button" class="next-match">Next</button>
        <button type="button" class="replace-one">Replace</button>
        <button type="button" class="replace-all">Replace All</button>
        <button type="button" class="close-search icon-button" title="Close">×</button>
      </div>
      <div class="search-options">
        <label><input type="checkbox" class="case-sensitive"> Case sensitive</label>
        <label><input type="checkbox" class="whole-word"> Whole word</label>
        <label><input type="checkbox" class="regex-search"> Regular expression</label>
        <span class="match-info">0 matches</span>
      </div>`;

    this.editorHostEl = document.createElement("div");
    this.editorHostEl.className = "editor-host";

    this.el.append(this.tabsEl, this.searchPanelEl, this.editorHostEl);

    this.editor = new EditorView(
      this.editorHostEl,
      content => {
        if (this.suppressChange) return;
        const doc = this.tabs.getActive();
        if (!doc) return;
        doc.content = content;
        doc.modified = true;
        this.tabs.render();
        this.handlers.onStatusChange(this.id);
      },
      () => this.handlers.onStatusChange(this.id)
    );

    this.tabs = new TabManager(this.tabsEl, {
      onActivate: doc => this.loadDocument(doc),
      onRequestClose: doc => this.handlers.onRequestClose(this.id, doc),
      onClose: (_, active) => {
        if (active) this.loadDocument(active);
        else this.showEmpty();
        this.handlers.onTabsChanged?.();
      },
      onMove: id => this.handlers.onMove(this.id, id),
      onDropTab: (id, sourcePane) => this.handlers.onDropTab(this.id, id, sourcePane)
    });
    this.tabs.paneId = id;

    const q = sel => this.searchPanelEl.querySelector(sel);
    this.search = new SearchController(this.editor, {
      searchInput: q(".search-input"),
      replaceInput: q(".replace-input"),
      prevMatch: q(".prev-match"),
      nextMatch: q(".next-match"),
      replaceOne: q(".replace-one"),
      replaceAll: q(".replace-all"),
      caseSensitive: q(".case-sensitive"),
      wholeWord: q(".whole-word"),
      regexSearch: q(".regex-search")
    });
    q(".close-search").addEventListener("click", () => this.closeSearch());

    this.el.addEventListener("focusin", () => this.handlers.onFocus(this.id));
    this.el.addEventListener("mousedown", () => this.handlers.onFocus(this.id));

    this.showEmpty();
  }

  getActive() {
    return this.tabs.getActive();
  }

  addDocument(doc) {
    this.tabs.add(doc);
    this.loadDocument(doc);
  }

  activate(id) {
    this.tabs.activate(id);
  }

  loadDocument(doc) {
    this.suppressChange = true;
    doc.language ||= languageFromFilename(doc.name);

    const emptyMessage = this.editorHostEl.querySelector(".editor-empty-message");
    if (emptyMessage) emptyMessage.remove();

    this.editor.setValue(doc.content, doc.language);
    this.suppressChange = false;
    this.editorHostEl.classList.remove("empty");
    this.handlers.onStatusChange(this.id);
  }

  showEmpty() {
    this.suppressChange = true;
    this.editor.clear();
    this.suppressChange = false;

    this.editorHostEl.classList.add("empty");
    let emptyMessage = this.editorHostEl.querySelector(".editor-empty-message");
    if (!emptyMessage) {
      emptyMessage = document.createElement("div");
      emptyMessage.className = "editor-empty-message";
      emptyMessage.textContent = "No file opened";
      this.editorHostEl.append(emptyMessage);
    }
    this.handlers.onStatusChange(this.id);
  }

  openSearch() {
    this.searchPanelEl.classList.remove("hidden");
    const input = this.searchPanelEl.querySelector(".search-input");
    input.focus();
    input.select();
  }

  closeSearch() {
    this.searchPanelEl.classList.add("hidden");
    this.editor.focus();
  }

  isSearchOpen() {
    return !this.searchPanelEl.classList.contains("hidden");
  }

  formatActiveDocument() {
    const doc = this.tabs.getActive();
    if (!doc) return;
    if (doc.language === "c" || doc.language === "cpp") {
      this.editor.formatC();
    }
  }
}
