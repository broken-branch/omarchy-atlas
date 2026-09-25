# Using Atlas

## Primary flow

1. Add a root explicitly: `atlas root-add ~/Projects/notes`, or from the
   popup's Roots page. Nothing is indexed until added. `atlas index` builds
   the map; the server and the report commands re-index first when the
   saved index is older than 2 s.
2. Ask the CLI. `atlas orphans`, `atlas dangling` and `atlas stale` print a
   short table and exit 1 when they have findings, so a repository can run
   one as a CI step; `atlas cost` prints its table and exits 0. `--json`
   gives programs the same data.
3. Open the popup. The Atlas mark sits in the bar while the plugin is
   enabled; click it or run
   `omarchy-shell io.github.broken-branch.atlas toggle`. Search paths, titles
   and content, pick a root, open a finding (orphan files, dangling
   references, stale files), Recently edited or All files, select a file,
   see its facts. Recently edited includes open files of any age.
4. Read. `o` or Enter in the popup, `atlas show --root NAME --path REL`, or a
   link in the reader opens the document in the reader window with the
   active Omarchy theme: headings, tables, task lists, highlighted code,
   Mermaid diagrams, an outline, and a backlinks footer. Indexed references
   in document text can be followed; impact relationships from
   `docs/impact.yml` appear in facts and the map. The header carries Back,
   Forward, the breadcrumb and Files · Neighbourhood ·
   Whole map; Files opens the picker for one root or all roots; Previous
   file / Next file walk the list the document was opened from; the action
   row is Map · Edit · Details. `e` opens the file in the Omarchy default
   editor. The reader needs the server: the installed plugin's service keeps
   it running; from a plain checkout, run `python3 -B atlas.py serve` first.
   With the server down, `atlas show` still opens the window, on a page that
   cannot load.
5. See the neighbourhood, then the whole thing. `n` or Neighbourhood opens
   the map view on the full canvas scoped to the document: the file and one
   hop of incoming and outgoing references, the direct-reference list beside
   the canvas (below it at narrow widths) with Read/Edit/Details; Back
   returns to the document. `m`, `atlas show --map` (with `--root` and
   `--path`) or Whole map opens the browser map as a history destination:
   every file as a node, every reference as an edge, coloured by kind,
   clustered by root, hover to isolate a neighbourhood, pan and zoom, filter,
   search-and-fly, click to select, double-click or Enter to read. Orphans sit
   at the fringe, dangling targets are hollow, and stale files have a yellow
   tick. Back returns to the document, and Back
   from a document opened off the map restores the map view.
6. Keep working. Files open in an editor or modified within 30 minutes have
   red recency marks; files modified within 24 hours have orange marks. The
   map shows both counts and a Recent filter that includes open files of any
   age. See the [exact rule and marker limits](contract.md#definitions).
   The reader and map reload on file change and restyle on theme change
   without a restart; the popup re-indexes on `r` and shows the
   time of its data. The [README's key table](../README.md#keys) lists every
   key.

## Behaviour and boundaries

- Read-only over projects. Atlas never creates, edits, moves or renames a
  document, and never writes outside `~/.config/omarchy-atlas/` and
  `~/.cache/omarchy-atlas/`.
- Definitions are the [reference's](contract.md#definitions). An orphan is a
  file nothing refers to in any style Atlas can read; a dangling reference is
  a Markdown link, wikilink or `@path` import with no target, within the
  [reference limits](contract.md#definitions); stale is measured only where
  `docs/impact.yml` ([format](../README.md#stale-files)) says what a doc
  depends on. Missing inputs produce an `unavailable` line, not a guess.
- Cross-root references (`~/Projects/notes/CLAUDE.md` from another root's
  `AGENTS.md`) resolve when both roots are registered; otherwise they are
  prose.
- No accounts, network beyond `127.0.0.1`, or model calls. The reader's
  libraries are local files.
