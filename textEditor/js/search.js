export class SearchController {
  constructor(editor, elements) {
    this.editor = editor;
    this.el = elements;
    this.lastTerm = "";
    this.bind();
  }

  options() {
    return {
      caseSensitive: this.el.caseSensitive.checked,
      wholeWord: this.el.wholeWord.checked,
      regex: this.el.regexSearch.checked
    };
  }

  bind() {
    this.el.searchInput.addEventListener("input", () => this.updateCount());
    this.el.searchInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.shiftKey ? this.previous() : this.next();
      }
    });
    this.el.prevMatch.addEventListener("click", () => this.previous());
    this.el.nextMatch.addEventListener("click", () => this.next());
    this.el.replaceOne.addEventListener("click", () => this.replaceOne());
    this.el.replaceAll.addEventListener("click", () => this.replaceAll());
    for (const x of [this.el.caseSensitive, this.el.wholeWord, this.el.regexSearch]) {
      x.addEventListener("change", () => this.updateCount());
    }
  }

  updateCount() {
    const matches = this.editor.getMatches(this.el.searchInput.value, this.options());
    this.el.matchInfo.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
  }

  next() {
    const term = this.el.searchInput.value;
    const start = this.editor.getCursor().line; // selection is handled below
    const textarea = this.editor.textarea;
    const from = textarea.selectionEnd;
    this.editor.findAndSelect(term, this.options(), from, false) ||
      this.editor.findAndSelect(term, this.options(), 0, false);
    this.updateCount();
  }

  previous() {
    const term = this.el.searchInput.value;
    const textarea = this.editor.textarea;
    const from = textarea.selectionStart;
    this.editor.findAndSelect(term, this.options(), from || textarea.value.length, true) ||
      this.editor.findAndSelect(term, this.options(), textarea.value.length, true);
    this.updateCount();
  }

  replaceOne() {
    const term = this.el.searchInput.value;
    const textarea = this.editor.textarea;
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    const options = this.options();
    const matches = this.editor.getMatches(term, options);
    if (selected && matches.some(m => m.index === textarea.selectionStart && m.length === selected.length)) {
      this.editor.replaceSelection(this.el.replaceInput.value);
    }
    this.next();
  }

  replaceAll() {
    const term = this.el.searchInput.value;
    if (!term) return;
    const options = this.options();
    const replacement = this.el.replaceInput.value;
    const textarea = this.editor.textarea;
    let value = textarea.value;

    if (options.regex) {
      try {
        const flags = options.caseSensitive ? "g" : "gi";
        const re = new RegExp(options.wholeWord ? `\\b(?:${term})\\b` : term, flags);
        value = value.replace(re, replacement);
      } catch {
        return;
      }
    } else {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(options.wholeWord ? `\\b${escaped}\\b` : escaped, options.caseSensitive ? "g" : "gi");
      value = value.replace(re, replacement);
    }

    if (value !== textarea.value) this.editor.replaceSelection(value);
    this.updateCount();
  }
}
