const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const js = fs.readFileSync(path.join(root, "app.js"), "utf8");

const errors = [];

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  resources: "usable",
  url: "http://localhost/",
});

dom.window.onerror = (msg) => errors.push(String(msg));
dom.window.console.error = (...args) => errors.push(args.join(" "));

// jsdom doesn't fetch external stylesheets/fonts by default with runScripts;
// that's fine, we only care about JS behavior here. Strip the <link> tags
// that would try to hit the network so this test runs offline/CI-safe.
const doc = dom.window.document;
[...doc.querySelectorAll("link[rel=stylesheet], link[rel=preconnect]")].forEach((l) => l.remove());

// Inject app.js manually (module executes an IIFE against document.*)
const scriptEl = doc.createElement("script");
scriptEl.textContent = js;
doc.body.appendChild(scriptEl);

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("OK:", msg);
}

// Give any microtasks a tick
setTimeout(() => {
  try {
    // 1. Initial state: drop hint visible, toolbar hidden
    assert(!doc.getElementById("dropHint").hidden, "drop hint visible before load");
    assert(doc.getElementById("toolbar").hidden, "toolbar hidden before load");

    // 2. Click "Try a sample"
    doc.getElementById("sampleBtn").dispatchEvent(new dom.window.Event("click", { bubbles: true }));

    assert(doc.getElementById("dropHint").hidden, "drop hint hidden after sample load");
    assert(!doc.getElementById("toolbar").hidden, "toolbar visible after sample load");
    assert(!doc.getElementById("statsBar").hidden, "stats bar visible after sample load");

    const treeItems = doc.querySelectorAll("#treeRoot > .tree-item");
    assert(treeItems.length > 5, "tree root has multiple top-level groups (" + treeItems.length + ")");

    // 3. Switch to "Enabled (=y)" tab
    doc.querySelector('.tab[data-tab="enabled"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    const enabledRows = doc.querySelectorAll("#enabledList .flat-row");
    assert(enabledRows.length === 19, "enabled tab lists exactly 19 =y symbols, got " + enabledRows.length);
    assert(
      doc.getElementById("enabledCount").textContent.includes("19"),
      "enabled count label shows 19"
    );

    // 4. Switch to "All symbols" tab
    doc.querySelector('.tab[data-tab="all"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    const allRows = doc.querySelectorAll("#allTableBody tr");
    assert(allRows.length === 36, "all-symbols tab lists all 36 parsed symbols, got " + allRows.length);

    // 4b. Top-level-only filter on the Enabled tab
    doc.querySelector('.tab[data-tab="enabled"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    const topLevelCheckbox = doc.getElementById("topLevelOnly");
    topLevelCheckbox.checked = true;
    topLevelCheckbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const topLevelNames = [...doc.querySelectorAll("#enabledList .flat-row .name")].map((n) => n.textContent);
    assert(
      topLevelNames.includes("CONFIG_BT") && !topLevelNames.includes("CONFIG_BT_PERIPHERAL"),
      "top-level-only filter keeps CONFIG_BT but excludes CONFIG_BT_PERIPHERAL"
    );
    assert(
      topLevelNames.every((n) => !n.replace(/^CONFIG_/, "").includes("_")),
      "every row under top-level-only filter has no further underscore"
    );
    topLevelCheckbox.checked = false;
    topLevelCheckbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    // 5. Search filter on tree tab
    doc.querySelector('.tab[data-tab="tree"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    const searchInput = doc.getElementById("searchInput");
    searchInput.value = "peripheral";
    searchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const treeLeaf = doc.querySelector(".tree-leaf");
    assert(!!treeLeaf, "filtered tree still renders a leaf row for 'peripheral'");
    assert(
      doc.body.textContent.toLowerCase().includes("peripheral"),
      "filtered tree view contains the searched token"
    );

    // 6. Click a leaf to open details panel
    treeLeaf.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    assert(!doc.getElementById("detailsPanel").hidden, "details panel opens on leaf click");
    assert(
      doc.getElementById("detailsBody").textContent.includes("CONFIG_BT_PERIPHERAL"),
      "details panel shows the clicked symbol name"
    );

    // 7. Clear
    searchInput.value = "";
    searchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    doc.getElementById("clearBtn").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    assert(!doc.getElementById("dropHint").hidden, "drop hint reappears after Clear");
    assert(doc.getElementById("toolbar").hidden, "toolbar hides after Clear");

    if (errors.length) {
      console.log("\nRuntime errors captured during test:");
      errors.forEach((e) => console.log(" -", e));
      process.exitCode = 1;
    } else {
      console.log("\nALL SMOKE TESTS PASSED, no runtime errors.");
    }
  } catch (e) {
    console.error("\nTEST FAILURE:", e.message);
    if (errors.length) {
      console.log("Runtime errors captured:");
      errors.forEach((er) => console.log(" -", er));
    }
    process.exitCode = 1;
  }
}, 100);
