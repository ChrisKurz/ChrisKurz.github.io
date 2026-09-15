export class TabManager {
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.documents = [];
    this.activeId = null;
    this.paneId = null;

    this.container.addEventListener("dragover", e => {
      if (e.dataTransfer.types.includes("text/tab-id")) e.preventDefault();
    });
    this.container.addEventListener("drop", e => {
      const id = e.dataTransfer.getData("text/tab-id");
      const sourcePane = e.dataTransfer.getData("text/source-pane");
      if (!id) return;
      e.preventDefault();
      this.callbacks.onDropTab?.(id, sourcePane === "" ? null : Number(sourcePane));
    });
  }

  add(doc) {
    this.documents.push(doc);
    this.activeId = doc.id;
    this.render();
  }

  getActive() {
    return this.documents.find(d => d.id === this.activeId) || null;
  }

  activate(id) {
    if (!this.documents.some(d => d.id === id)) return;
    this.activeId = id;
    this.render();
    this.callbacks.onActivate(this.getActive());
  }

  updateActive(content) {
    const d = this.getActive();
    if (d) d.content = content;
    this.render();
  }

  close(id) {
    const index = this.documents.findIndex(d => d.id === id);
    if (index < 0) return;

    const doc = this.documents[index];

    if (doc.modified) {
      this.callbacks.onRequestClose(doc);
      return;
    }

    this.closeImmediately(id);
  }

  closeImmediately(id) {
    const index = this.documents.findIndex(d => d.id === id);
    if (index < 0) return;

    const doc = this.documents[index];
    this.documents.splice(index, 1);

    if (this.activeId === id) {
      const next = this.documents[index] || this.documents[index - 1] || null;
      this.activeId = next?.id || null;
    }

    this.render();
    this.callbacks.onClose(doc, this.getActive());
  }

  render() {
    this.container.innerHTML = "";

    for (const doc of this.documents) {
      const tab = document.createElement("div");
      tab.className =
        "tab" +
        (doc.id === this.activeId ? " active" : "") +
        (doc.modified ? " modified" : "");

      tab.setAttribute("role", "tab");
      tab.title = doc.path || doc.name;

      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = doc.name;

      tab.draggable = true;
      tab.addEventListener("dragstart", e => {
        e.dataTransfer.setData("text/tab-id", doc.id);
        e.dataTransfer.setData("text/source-pane", String(this.paneId ?? ""));
        e.dataTransfer.effectAllowed = "move";
      });

      const move = document.createElement("button");
      move.className = "tab-move";
      move.textContent = "⇄";
      move.title = "Move to other pane";
      move.addEventListener("click", e => {
        e.stopPropagation();
        this.callbacks.onMove?.(doc.id);
      });

      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "Close";
      close.addEventListener("click", e => {
        e.stopPropagation();
        this.close(doc.id);
      });

      tab.append(name, move, close);
      tab.addEventListener("click", () => this.activate(doc.id));
      this.container.append(tab);
    }
  }
}
