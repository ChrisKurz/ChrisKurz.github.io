import { highlight } from "./syntax.js";

export class EditorView {
  constructor(host, onChange, onCursorChange) {
    this.host = host;
    this.onChange = onChange;
    this.onCursorChange = onCursorChange;
    this.language = "plaintext";

    this.shell = document.createElement("div");
    this.shell.className = "editor-shell";

    this.lines = document.createElement("div");
    this.lines.className = "line-numbers";

    this.wrap = document.createElement("div");
    this.wrap.className = "code-wrap";

    this.highlightLayer = document.createElement("pre");
    this.highlightLayer.className = "highlight";
    this.highlightLayer.setAttribute("aria-hidden", "true");

    this.textarea = document.createElement("textarea");
    this.textarea.className = "code-editor";
    this.textarea.spellcheck = false;
    this.textarea.wrap = "off";

    this.wrap.append(this.highlightLayer, this.textarea);
    this.shell.append(this.lines, this.wrap);
    this.host.append(this.shell);

    this.textarea.addEventListener("input", () => {
      this.render();
      this.onChange(this.textarea.value);
      this.onCursorChange();
    });

    this.textarea.addEventListener("scroll", () => this.syncScroll());
    this.textarea.addEventListener("keyup", () => this.onCursorChange());
    this.textarea.addEventListener("click", () => this.onCursorChange());

    this.textarea.addEventListener("keydown", e => {
      if (e.key === "Tab") {
        e.preventDefault();
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        this.textarea.setRangeText("    ", start, end, "end");
        this.render();
        this.onChange(this.textarea.value);
        this.onCursorChange();
        return;
      }

      // C/C++: keep indentation useful while writing code from scratch.
      if (e.key === "Enter" && this.isC()) {
        e.preventDefault();
        this.insertIndentedNewline();
        return;
      }

      // C/C++: when a block comment is closed, normalize the current
      // document formatting without moving the cursor unexpectedly.
      if (e.key === "*" && this.isC()) {
        setTimeout(() => {
          const pos = this.textarea.selectionStart;
          const before = this.textarea.value.slice(Math.max(0, pos - 2), pos);
          if (before === "*/") this.formatC({ preserveCursor: true });
        }, 0);
      }
    });
  }

  isC() {
    return this.language === "c" || this.language === "cpp";
  }

  setValue(value, language) {
    this.language = language;
    this.textarea.value = value;
    this.render();
    this.onCursorChange();
  }

  getValue() {
    return this.textarea.value;
  }

  clear() {
    this.textarea.value = "";
    this.highlightLayer.innerHTML = "";
    this.lines.innerHTML = "<div>1</div>";
    this.textarea.scrollTop = 0;
    this.textarea.scrollLeft = 0;
    this.textarea.setSelectionRange(0, 0);
    this.syncScroll();
  }

  getCursor() {
    const value = this.textarea.value;
    const position = this.textarea.selectionStart || 0;
    const before = value.slice(0, position);
    const lines = before.split("\n");
    return {
      line: lines.length,
      col: lines[lines.length - 1].length + 1
    };
  }

  focus() {
    this.textarea.focus();
  }

  render() {
    const value = this.textarea.value;
    this.highlightLayer.innerHTML =
      highlight(value, this.language || "plaintext") + (value.endsWith("\n") ? " " : "");
    const count = Math.max(1, value.split("\n").length);
    this.lines.innerHTML = Array.from(
      { length: count },
      (_, i) => `<div>${i + 1}</div>`
    ).join("");
    this.syncScroll();
  }

  syncScroll() {
    this.highlightLayer.scrollTop = this.textarea.scrollTop;
    this.highlightLayer.scrollLeft = this.textarea.scrollLeft;
    this.lines.scrollTop = this.textarea.scrollTop;
  }

  insertIndentedNewline() {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    const value = this.textarea.value;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const currentLine = value.slice(lineStart, start);
    const currentIndent = (currentLine.match(/^[ \t]*/) || [""])[0];

    let indent = currentIndent;
    const trimmed = currentLine.trimEnd();

    if (/[{]\s*(?:\/\/.*)?$/.test(trimmed) || /\/\*\s*$/.test(trimmed)) {
      indent += "    ";
    }

    // Closing a block on a new line should align with the opening brace.
    if (/^\s*}/.test(value.slice(start, end || start + 1))) {
      indent = currentIndent.replace(/ {4}$/, "");
    }

    this.textarea.setRangeText("\n" + indent, start, end, "end");
    this.render();
    this.onChange(this.textarea.value);
    this.onCursorChange();
  }

  formatC({ preserveCursor = true } = {}) {
    if (!this.isC()) return false;

    const oldValue = this.textarea.value;
    const oldCursor = this.textarea.selectionStart;

    // Lightweight, deterministic C/C++ formatter. It intentionally avoids
    // changing strings, comments, or preprocessor lines.
    const lines = oldValue.replace(/\r\n/g, "\n").split("\n");
    let level = 0;
    const formatted = [];

    for (let raw of lines) {
      const trimmed = raw.trim();

      if (trimmed === "") {
        formatted.push("");
        continue;
      }

      if (/^}/.test(trimmed)) {
        level = Math.max(0, level - 1);
      }

      // Preserve preprocessor directives at column zero.
      const output = /^#/.test(trimmed)
        ? trimmed
        : "    ".repeat(level) + trimmed.replace(/[ \t]+$/g, "");

      formatted.push(output);

      // Count braces while ignoring strings and comments approximately.
      const codeOnly = trimmed
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/\/\/.*$/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      const opens = (codeOnly.match(/{/g) || []).length;
      const closes = (codeOnly.match(/}/g) || []).length;
      level = Math.max(0, level + opens - closes);
    }

    const nextValue = formatted.join("\n");
    if (nextValue === oldValue) return false;

    this.textarea.value = nextValue;

    if (preserveCursor) {
      const beforeCursor = oldValue.slice(0, oldCursor);
      const oldLine = beforeCursor.split("\n").length - 1;
      const oldColumn = beforeCursor.split("\n").at(-1).length;
      const newLines = nextValue.split("\n");
      const targetLine = Math.min(oldLine, newLines.length - 1);
      const targetColumn = Math.min(oldColumn, newLines[targetLine].length);
      const newCursor =
        newLines.slice(0, targetLine).reduce((n, line) => n + line.length + 1, 0) +
        targetColumn;
      this.textarea.setSelectionRange(newCursor, newCursor);
    }

    this.render();
    this.onChange(this.textarea.value);
    this.onCursorChange();
    return true;
  }

  replaceSelection(text) {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    this.textarea.setRangeText(text, start, end, "end");
    this.render();
    this.onChange(this.textarea.value);
    this.onCursorChange();
  }

  findAndSelect(term, options, from = 0, backwards = false) {
    const text = this.textarea.value;
    if (!term) return null;

    let index = -1;
    if (options.regex) {
      try {
        const flags = options.caseSensitive ? "g" : "gi";
        const re = new RegExp(options.wholeWord ? `\\b(?:${term})\\b` : term, flags);
        if (backwards) {
          let m;
          while ((m = re.exec(text)) !== null) {
            if (m.index >= from) break;
            index = m.index;
          }
        } else {
          re.lastIndex = from;
          const m = re.exec(text);
          index = m ? m.index : -1;
        }
      } catch {
        return null;
      }
    } else {
      const haystack = options.caseSensitive ? text : text.toLowerCase();
      const needle = options.caseSensitive ? term : term.toLowerCase();
      if (backwards) {
        index = haystack.lastIndexOf(needle, Math.max(0, from - 1));
      } else {
        index = haystack.indexOf(needle, from);
      }
      if (options.wholeWord && index >= 0) {
        const isWord = c => c && /[\w$]/.test(c);
        while (
          index >= 0 &&
          (isWord(text[index - 1]) || isWord(text[index + term.length]))
        ) {
          index = haystack.indexOf(needle, index + 1);
        }
      }
    }

    if (index < 0) return null;
    this.textarea.focus();
    this.textarea.setSelectionRange(index, index + term.length);
    return { index, length: term.length };
  }

  getMatches(term, options) {
    if (!term) return [];
    const text = this.textarea.value;
    const result = [];

    if (options.regex) {
      try {
        const flags = options.caseSensitive ? "g" : "gi";
        const re = new RegExp(options.wholeWord ? `\\b(?:${term})\\b` : term, flags);
        let m;
        while ((m = re.exec(text)) !== null) {
          result.push({ index: m.index, length: m[0].length });
          if (m[0].length === 0) re.lastIndex++;
        }
      } catch {
        return [];
      }
    } else {
      const haystack = options.caseSensitive ? text : text.toLowerCase();
      const needle = options.caseSensitive ? term : term.toLowerCase();
      let p = 0;
      while ((p = haystack.indexOf(needle, p)) !== -1) {
        if (
          !options.wholeWord ||
          !(/[\w$]/.test(text[p - 1] || "") ||
            /[\w$]/.test(text[p + term.length] || ""))
        ) {
          result.push({ index: p, length: needle.length });
        }
        p += Math.max(needle.length, 1);
      }
    }
    return result;
  }
}
