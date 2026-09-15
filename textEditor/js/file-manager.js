export class FileManager {
  constructor() {
    this.handles = new Map();
  }

  async readFile(file, path = "") {
    return {
      id: crypto.randomUUID(),
      name: file.name,
      path: path || file.webkitRelativePath || file.name,
      content: await file.text(),
      language: null,
      modified: false,
      handle: null
    };
  }

  async openWithHandle() {
    if (!window.showOpenFilePicker) return null;
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{
        description: "Text and source files",
        accept: {
          "text/plain": [".txt", ".c", ".h", ".cpp", ".hpp", ".cc", ".js", ".css", ".html", ".json", ".py", ".rs", ".kconfig", ".md"],
          "text/*": [".c", ".h", ".cpp", ".hpp", ".cc", ".kconfig", ".conf", ".cfg"]
        }
      }],
      excludeAcceptAllOption: false
    });
    const file = await handle.getFile();
    const doc = await this.readFile(file);
    doc.handle = handle;
    this.handles.set(doc.id, handle);
    return doc;
  }

  async save(doc) {
    if (doc.handle && doc.handle.createWritable) {
      const writable = await doc.handle.createWritable();
      await writable.write(doc.content);
      await writable.close();
      doc.modified = false;
      return true;
    }
    return this.saveAs(doc);
  }

  async saveAs(doc) {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: doc.name || "untitled.txt",
        types: [{ description: "Text file", accept: { "text/plain": [".txt"] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(doc.content);
      await writable.close();
      doc.handle = handle;
      doc.path = handle.name;
      doc.name = handle.name;
      doc.modified = false;
      this.handles.set(doc.id, handle);
      return true;
    }

    const blob = new Blob([doc.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.name || "untitled.txt";
    a.click();
    URL.revokeObjectURL(url);
    doc.modified = false;
    return true;
  }
}
