# Stack and why

## Shape

The repository **is** the plugin. `manifest.json`, `Panel.qml`, `Service.qml`
and the backend sit at the repository root, so the three stock commands are
the whole lifecycle:

```sh
omarchy plugin add https://github.com/broken-branch/omarchy-atlas.git --enable
omarchy plugin update io.github.broken-branch.atlas
omarchy plugin remove io.github.broken-branch.atlas
```

`add` clones into `~/.config/omarchy/plugins/io.github.broken-branch.atlas`, runs
`omarchy plugin validate`, and enables; `update` pulls, validates and rescans;
`remove` deletes the clone. There is no installer, uninstaller, ownership
marker, systemd unit, desktop entry or theme template of our own. `docs/`,
`tests/` and `scripts/` ride along in the clone as they do for every
third-party plugin.

```
manifest.json      id io.github.broken-branch.atlas, kinds ["bar-widget","service"]
Panel.qml          native bar widget + anchored popup; Panel*.qml hold its pages and rows
Service.qml        keeps `atlas.py serve` alive while the plugin is enabled
PanelBridge.js     process bridge for queued panel requests
ui/IndexModel.js   popup data model
atlas.py           CLI entry; atlas_index.py, atlas_analyze.py, atlas_serve.py
reader/            index.html, app.js, app.css, map.js, map.css, vendor/ (pinned libraries)
bin/atlas          wrapper that runs the atlas.py beside it
docs/ tests/ scripts/
```

## Runtime

- **Panel**: Omarchy shell / Quickshell QML. Manifest schema 1, id
  `io.github.broken-branch.atlas`, `kinds: ["bar-widget","service"]`,
  `entryPoints.barWidget: "Panel.qml"`, `entryPoints.service:
  "Service.qml"`, `barWidget.defaultSection: right`. Theme through `qs.Commons` `Color`/`Style`;
  controls from `qs.Ui`.
- **Service**: `Service.qml` is mounted at shell startup while the plugin is
  enabled. It runs one `Quickshell.Io.Process` —
  `["setpriv","--pdeathsig","TERM","python3","-B",<dir>/atlas.py,"serve"]` —
  and restarts it from a timer on exit, the same idiom as the first-party
  clipboard watchers. The kernel kills the server with the shell; disabling
  the plugin stops it.
- **Backend**: Python 3 standard library, entry `atlas.py`, sibling modules
  `atlas_index.py`, `atlas_analyze.py`, `atlas_auth.py`, `atlas_serve.py`. The panel invokes it
  as an argv array through `Quickshell.Io.Process`, one request per process,
  one JSON line on stdout — exactly as first-party panels call `omarchy-*`
  scripts. `bin/atlas` is a two-line wrapper for people and CI.
- **Server**: `atlas.py serve`, `http.server` on `127.0.0.1:4137`. Serves the
  reader, index JSON, raw files inside roots, a theme stylesheet and an SSE
  event stream. It checks the owner credential or browser session before
  serving requests and re-indexes lazily (contract).
- **Reader**: static HTML/CSS/JS in `reader/`, shown by
  `omarchy-launch-or-focus-webapp` in a Chromium `--app=` window. Markdown by
  `markdown-it`, code and Mermaid source by `highlight.js`, the map by
  `force-graph` (d3-force plus canvas, pan/zoom and hover in one file) —
  pinned files in `reader/vendor/` with versions and SHA-256 in
  `reader/vendor/VERSIONS`, refreshed only by `scripts/vendor-update` at
  development time.
- **Theme**: the server reads current `colors.toml` and consumed shell style
  inputs defined in the contract and serves `/theme.css` as CSS custom
  properties. A `theme` SSE event fires when effective values change. No template
  to install, nothing of ours in `~/.config/omarchy/themed/`.
- **Time source**: last commit time from one Git history traversal per git
  roots (clone time makes mtime meaningless), else mtime. File discovery uses
  `git ls-files -co --exclude-standard` in git roots so `node_modules`,
  `.venv` and build output fall out with the project's own ignore rules;
  non-git roots walk with a fixed exclude list.
- **State**: `~/.config/omarchy-atlas/config.json` (roots) and
  `~/.cache/omarchy-atlas/index.json`. Nothing is written into a project or
  into the plugin clone; bytecode is suppressed with `-B`.

## Why this stack

Omarchy is bash, Python 3, and QML/JS. Its first-party panels spawn `omarchy-*` scripts that print
JSON, its services supervise children with `setpriv --pdeathsig`, and its
plugin lifecycle is `git clone` plus a manifest check. Python is what Omarchy
reaches for when bash can no longer hold the structure
(`omarchy-agent-usage-*`, `omarchy-file-select`). Everything is text that
hot-reloads. Building Markdown Atlas in the same materials means an Omarchy user can
read all of it, `omarchy plugin update` is the upgrade path, and an Omarchy
update cannot break a toolchain Markdown Atlas does not have.

Rich rendering belongs in the browser, which is how Omarchy delivers its own
manual and ships HEY, Basecamp and the rest as web apps. The shell process
cannot host a browser view, and Qt rich text tops out at
"serviceable" with no code highlighting. Splitting the *panel* (lists, facts,
keyboard — where QML is strong) from the *reader and map* (typography,
highlighting, Mermaid source, a thousand animated nodes — where the browser is
strong) is cheaper than either trying to do both.

The workload is small: hundreds of Markdown files, with the reader I/O-bound
in a browser. Nothing here is faster or
safer for being compiled.

## Rejected

- **Rendered Mermaid diagrams.** The Omarchy marketplace security baseline rejects text files over 512 KiB; the vendored Mermaid distribution exceeds that limit. Mermaid fences and `.mmd`/`.mermaid` files remain indexed and show highlighted source in the reader.

- **A custom installer** (`bin/install` copying into the plugins dir with
  ownership markers and rollback), the plugin payload under a `plugin/`
  subdirectory, a systemd user unit, an installer-managed desktop entry, a
  theme `.tpl` of our own. Each reinvents a stock command and prevents
  `omarchy plugin add/update/remove` from managing the plugin directly.
- **Obsidian as the tool.** Its graph sees only Markdown links and wikilinks,
  while Markdown Atlas also indexes path references and impact rules; it
  cannot run in CI; its conventions (wikilinks, a notes vault, rename-with-
  rewrite) drift docs away from what agents read. It remains a fine reader;
  Markdown Atlas does not depend on it.
- **Markdown rendered in QML rich text.** No highlighting, an HTML-4-era
  subset, slow for long documents.
- **QtWebEngine inside the plugin.** Not initialised by quickshell; cannot be
  retrofitted from a plugin.
- **Rust or Go.** Would need committed binaries or a compile step that
  `omarchy plugin add` does not have; buys nothing measurable at this scale.
- **Ruby.** Not a dependency Omarchy's OS tooling takes; python3 already is.
- **Python Markdown or Pygments packages.** Not stdlib, and unnecessary: the
  backend never renders Markdown; the browser does. The backend needs only a
  fence-aware reference extractor.
- **A standalone Electron/Tauri app.** A second desktop runtime for one
  viewer, outside the shell's theme and IPC.
- **npm at runtime, a bundler, TypeScript.** Vendored pinned files are
  auditable with `sha256sum` and need no toolchain.
- **A graph drawn in QML `Canvas`.** A second graph implementation with
  worse interaction than the browser's; one map, in the browser.
- **`d3` alone for the map.** The same pan, zoom, hover and canvas drawing
  cost several hundred lines that `force-graph` already ships; it bundles
  `d3-force` and nothing else is needed.
- **Omitting the whole map.** Hover isolation, filters, root clusters and
  hiding `log` by default keep several hundred nodes legible, and the whole
  map is where unlinked and broken files show.
- **A floating window for the native surface.** Every first-party Omarchy
  plugin uses a bar widget with a popup; Markdown Atlas does the same.
- **Configurable exclude lists or ports.** No implemented feature needs
  them. Fixed values live in the contract; kinds are the one user-owned
  table (`kinds`, `kind-set`, `kind-remove`).

## Using the CLI outside the desktop

`atlas.py` depends on nothing but python3 and git, so a repository's CI can
run it without the plugin: clone `omarchy-atlas` and call
`python3 -B atlas.py orphans --path .` (or `dangling`, `stale`) from the
repository being checked; the [README](../README.md#in-ci) has a complete
job. `--path` indexes a directory ad hoc without touching config or cache.
On the desktop,
`ln -s ~/.config/omarchy/plugins/io.github.broken-branch.atlas/bin/atlas ~/.local/bin/atlas`
puts `atlas` on PATH; that link is the user's, not the plugin's.

## Verification

Python `unittest` against fixture trees in `tests/fixtures/` (plain and
git-initialised); route tests against an in-process server on an ephemeral
port; `node` tests for the reader's link resolution, the map model and the
panel's JS models; `omarchy-plugin-validate .` where available, else the same
manifest checks in Python; `sh -n`; `qmllint`/`qmlformat` with the shell's
`qs/{Ui,Commons}` import layout; `sha256sum -c` over `reader/vendor`. All from
`sh scripts/check`, the single CI entry point; hosts without the Omarchy
shell sources report the QML checks as unavailable. Installing with
`omarchy plugin add`, the popup, the reader window, live theme changes and
scaling are checked by hand on an Omarchy desktop.
