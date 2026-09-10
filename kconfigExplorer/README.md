# Kconfig Explorer

A small, static, client-side tool for browsing a Zephyr / nRF Connect SDK
(NCS) `.config` file (the merged Kconfig output, usually found at
`build/zephyr/.config`).

It runs entirely in the browser — no server, no build step, nothing is
uploaded anywhere. Open it, pick a file, and it parses and visualizes it
on the spot.

## What it does

- **Open or drag-and-drop** a `.config` file (or any plain-text file with
  `CONFIG_X=value` lines).
- **Tree view**: symbol names are split on `_` after the `CONFIG_` prefix
  and grouped into a folder-style tree, e.g.

  ```
  BT
  ├─ CENTRAL
  ├─ PERIPHERAL      (=y)
  ├─ GATT
  │  ├─ CLIENT        (=y)
  │  └─ DYNAMIC_DB    (=y)
  └─ LL
     └─ SW_SPLIT      (=y)
  ```

  `CONFIG_BT=y` and `CONFIG_BT_PERIPHERAL=y` both show up, with `BT` as an
  expandable group and `PERIPHERAL` nested inside it, matching the request
  in the brief.
- **Enabled (=y) tab**: a flat, searchable list of every symbol that is
  set to `y`, with a one-click export to a `.txt` file.
- **All symbols tab**: every parsed symbol in a sortable table (name,
  value, type, line number).
- **Search box**: filters whichever tab is active, and highlights matches
  in the tree.
- **Details panel**: click any symbol to see its value, type, whether it
  was explicitly set or explicitly unset (`# CONFIG_X is not set`), and
  the original line from the file.
- A **"Try a sample"** button loads a small built-in example `.config` so
  you can see the tool working immediately, without needing a real build
  directory.

## Parsing rules

- `CONFIG_NAME=y` / `=n` → boolean, shown with a coloured status dot.
- `CONFIG_NAME="some string"` → string (quotes stripped, escapes
  unescaped).
- `CONFIG_NAME=123` / `=0x1F` → number.
- `# CONFIG_NAME is not set` → treated as an explicitly-unset boolean
  (Kconfig's own convention for "no").
- Anything else (comments, blank lines) is ignored.

The tree is a pure string-splitting exercise on `_` — it doesn't know
Kconfig's actual `menuconfig` structure (that would require parsing the
`Kconfig` source files themselves, not just the generated `.config`), so
occasionally a group boundary will look a little different from the
"official" Kconfig menu. For the common case (`BT`, `BT_PERIPHERAL`,
`LOG`, `LOG_BACKEND_UART`, etc.) it lines up very well, which is what was
asked for.

## Deploying to GitHub Pages

1. Extract this zip into your repository (e.g. into the repo root, or into
   a subfolder like `docs/` or `kconfig-explorer/` if you want it alongside
   other content).
2. Commit and push.
3. In the repo's **Settings → Pages**, set the source to the branch/folder
   you used.
4. Visit `https://<your-username>.github.io/<repo>/` (or the relevant
   subpath). No build step, no dependencies to install — it's plain
   HTML/CSS/JS.

It also works simply by double-clicking `index.html` and opening it
locally in a browser, no web server required.

## Files

- `index.html` — page structure.
- `style.css` — all styling.
- `app.js` — parsing, tree-building, and all rendering/interaction logic.
- `test/smoke_test.js` — an optional Node.js smoke test (needs
  `npm install jsdom` first) that loads the real app files in a simulated
  DOM and exercises the main flows. Not needed to run the app itself; it's
  only there so future edits can be checked quickly.

## Browser support

Uses only standard, widely-supported APIs: `FileReader`, `Blob` +
`URL.createObjectURL`, and the native `<details>`/`<summary>` elements for
collapsible tree nodes. Works in current Chrome, Edge, Firefox, and
Safari.
