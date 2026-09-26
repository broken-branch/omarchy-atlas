# Contributing

Open an issue for a proposed behaviour change, then send a focused pull
request. Keep each change small enough to review in one sitting, and keep
[docs/contract.md](docs/contract.md) current when a command, JSON shape or
HTTP route changes.

## Ground rules

- Build it the way Omarchy is built: QML/JS for the panel, Python 3 standard
  library for the backend, `sh`/bash for small scripts, the browser for rich
  rendering. No compiled code, no build step, no npm or pip at install or run
  time.
- Browser libraries are pinned files in `reader/vendor/`, listed with version,
  source and SHA-256 in `reader/vendor/VERSIONS`. Change them only with
  `scripts/vendor-update`, and update `reader/vendor/NOTICE` when a bundle's
  contents change.
- The repository is the plugin. `manifest.json`, `Panel.qml`, `Service.qml`
  and `atlas.py` stay at the root so `omarchy plugin add/update/remove` is the
  whole lifecycle. No installer, uninstaller, systemd unit, desktop entry or
  theme template: if a stock Omarchy command exists (`omarchy commands` lists
  them), use it.
- Read-only over projects. Markdown Atlas writes only `~/.config/omarchy-atlas/` and
  `~/.cache/omarchy-atlas/`. Nothing is indexed until the user adds a root.
- Honest analysis. Orphan, dangling, stale and cost are defined in the
  contract. A reference style the indexer cannot see is a documented
  limitation, not a hidden heuristic. Report unavailable, stale and failed
  inputs distinctly; never invent results, times or links.
- Keep public descriptions of recency, filters, reader links and agent
  startup cost aligned with the [contract](docs/contract.md#definitions).
- The server binds `127.0.0.1` only and serves only files inside registered
  roots. It has no authentication because it has no remote users; do not add
  any.
- No network access beyond `127.0.0.1`, no telemetry, no model calls.
- UI copy is plain tool language: a label names the thing or the action, a
  hint names the key. No taglines or slogans, in the product or its docs.
- Every configuration key serves an implemented feature. No speculative
  options, one-caller abstractions or TODO comments.

## Tests

- Test user-visible behaviour through the CLI and the HTTP routes against
  fixture trees in `tests/fixtures/`. Do not mock the behaviour under test.
- A test should fail from one identifiable change to the code; name it after
  that behaviour.
- Expected CLI and JSON results are written by hand as behaviour assertions,
  not generated snapshots.
- Isolate `HOME` and the XDG directories. Tests make no network, GitHub, SSH
  or model calls and write no desktop configuration.
- Do not put personal paths, credentials or private project content in
  fixtures or screenshots.

## Layout

```
manifest.json        plugin manifest
Panel.qml, Panel*.qml, AtlasActionButton.qml
                     bar widget and popup
PanelBridge.js       queued process requests from the panel
Service.qml          keeps `atlas.py serve` running while the plugin is enabled
ui/IndexModel.js     popup data model
atlas.py             CLI entry point
atlas_index.py       roots, kinds, file discovery, references, cache
atlas_analyze.py     orphans, dangling, stale, cost, search
atlas_serve.py       HTTP server on 127.0.0.1:4137
reader/              reader and map: index.html, app.js, map.js, CSS, vendor/
bin/atlas            wrapper for the CLI
scripts/check        the gate
scripts/vendor-update  refreshes reader/vendor/ from pinned URLs
tests/               Python unittest and node --test suites, fixtures, smoke probes
docs/                user and reference documentation
```

## Checks

Run `sh scripts/demo-workspace OUT-DIR` to create four fictional projects for screenshots and local trials.
Use an empty output directory; `--git` gives each project one commit.

On an Omarchy desktop, run `sh scripts/theme-shots OUT-DIR ROOT-DIR [ROOT-DIR ...] [--size WxH] [--scale N] [--read ROOT/REL] [-- THEME ...]` to capture the whole map, a reader page, and the neighbourhood of the most-referenced file for each theme. The reader defaults to the first root's `README.md` (or its first Markdown file). Omit themes to use all installed system and user themes. `summary.json` records the files, dimensions, scale, roots, and colour match; a montage is also written when ImageMagick is installed.
The command registers every root in isolated temporary HOME and XDG directories, then stops its own server and Chromium processes.
Run `scripts/preview OUT.png [--theme NAME] [--size WxH] [--scale N]` on an Omarchy desktop for the marketplace map image (default: tokyo-night, 1600×900 at scale 2).
It builds four fictional roots in isolated HOME/XDG state and stops its server and Chromium when the capture finishes.

```sh
sh scripts/check
```

Run it before a pull request; CI runs the same script. It checks the required
documents, Python syntax, the manifest, JSON files, shell syntax, vendored
library checksums, runs the Python and `node --test` suites, and runs QML
lint and format. It uses no network, credentials or model calls. It needs
`python3`, `git` and Node.js.

Some checks need an Omarchy desktop and are reported as unavailable
elsewhere:

- `qmllint` and `qmlformat` against the shell's `qs.Ui` and `qs.Commons`
  sources in `/usr/share/omarchy/shell`;
- `omarchy-plugin-validate` (outside Omarchy the gate checks the manifest's
  fields itself);
- the popup, the reader window, live theme changes and scaling, which only a
  person on the desktop can see.

If you change QML and have an Omarchy desktop, say in the pull request which
of these you ran and what you looked at; if not, say that too.

## Security

Markdown Atlas is local only and trusts processes on the same computer. Report a way
to read files outside registered roots, or to reach the server from another
machine or from a web page, privately through GitHub private vulnerability
reporting: "Report a vulnerability" on the repository's
[Security tab](https://github.com/broken-branch/omarchy-atlas/security),
rather than a public issue.
