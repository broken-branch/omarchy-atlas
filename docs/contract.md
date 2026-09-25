# Contract: CLI, index, server

Authoritative for the CLI, the index and the server. A breaking change updates
this file and every implementation in the same change.

## Invocation and framing

`python3 -B <plugin-dir>/atlas.py <command> [options]`, where the plugin dir
is the repository root — `~/.config/omarchy/plugins/io.github.broken-branch.atlas` when
installed by `omarchy plugin add`, the checkout in development. `bin/atlas`
resolves its own symlink and execs the `atlas.py` beside the real file, so a
link to it in `~/.local/bin` works. QML passes an argv array through
`Quickshell.Io.Process` and always adds `--json`; one process handles one
request. Timeouts: 30 s for `index`, 10 s otherwise.

The collection commands `index`, `files`, `orphans`, `dangling`, `stale`,
`cost` and `search` accept `--path DIR` instead of `--root NAME`: the
directory is indexed ad hoc as a root named after its basename, without
reading or writing config or cache. This is the CI form.

For `file`, `show` and `edit`, `--path REL` is a file inside the required
`--root NAME`, not the ad-hoc directory option. Parsing is command-specific.

Without `--json` output is human text and the three gate commands —
`orphans`, `dangling`, `stale` — exit 1 when they have findings; every other
command exits 0 on success. A reported error (any code listed below) exits 3
in text mode, with one line on stderr, so it is never mistaken for findings.
`atlas --help` lists every command with a one-line description, in a fixed
order. With `--json` stdout is exactly one UTF-8 JSON object plus
`\n`, diagnostics go to stderr, and exit is 0 whenever a valid reply was
written — `{"version":1,"ok":true,"command":"…","data":{…}}` or
`{"version":1,"ok":false,"command":"…","code":"…","message":"…"}`. Malformed
arguments exit 2; a crash exits 3. QML treats non-JSON stdout, nonzero exit
and timeout as `backend_error`. Error codes: `no_roots`, `invalid_root`,
`not_found`, `outside_roots`, `denied` (a credential-shaped file),
`git_error`, `impact_unreadable`, `config_invalid`, `server_unavailable`,
`backend_error`. JSON is ASCII-escaped, so a filename that is not valid
UTF-8 still yields valid UTF-8 output (CLI and HTTP alike). A registered root
whose directory is gone stops only itself: the index covers the roots that
exist and lists the gone one in `unavailable` as `{root, reason:"root
missing"}`, every collection names it in its own `unavailable` (text output
adds a line `unavailable<TAB>NAME<TAB>root missing`), and `--root NAME` for it
— or `file`, `show` and `edit` in it — replies `invalid_root`. This holds for
a root that goes before it was ever indexed as well. When the directory
returns, the next read rebuilds. When every registered root is missing, the
gate commands reply `invalid_root` ("every registered root is missing"), so a
gate with nothing left to check never passes. A nested checkout whose `git
ls-files` fails (see the walk below) stops only itself in the same way: it is
listed as `{root, path:REL, reason:"git unavailable"}` and every collection
names it (text: `unavailable<TAB>NAME:REL<TAB>git unavailable`). An indexed
document that cannot be read makes a collection reply `backend_error` naming
the path — never a partial result.

Collection commands over registered roots read the saved index and rebuild
it first when it is older than 2 s (the server's refresh interval), when the
roots that exist or the roots that are missing differ from the ones it
lists, or when the kind table differs. `file`, `show` and `edit` find their
file the same way. `--path` always indexes fresh.

Panel.qml owns one `Process` and serialises requests; a reply is applied only
when its request generation is current.

## Commands

| CLI | `data` |
| --- | --- |
| `roots` | `{config}`; a registered root whose directory is gone carries `missing:true` in the reply (never in the stored config), and `root-remove` still removes it |
| `root-add PATH [--name NAME]` | `{config}`; PATH must be an existing directory, stored canonical; NAME defaults to the basename (`system` for `/`) and must be unique. A project, a drive's mount point or `/` are all valid roots. |
| `root-remove NAME` | `{config}` |
| `kinds` | `{kinds:[Kind]}` — the effective kind table: the user's entries first, in their order, then the built-ins. |
| `kind-set ID [--label TEXT] [--colour NAME-OR-HEX] [--path GLOB]... [--ext .EXT]...` | `{config}`; creates or updates the user's entry for ID (an existing built-in ID overrides its label, colour or match; a new ID adds a kind). ID is `[a-z][a-z0-9-]*`; a colour is one of the theme's names (`red yellow orange green cyan blue magenta brown bright_red bright_yellow bright_green bright_cyan bright_blue bright_magenta muted accent foreground`) or `#rrggbb`; a new kind needs at least one `--path` or `--ext` |
| `kind-remove ID` | `{config}`; removes the user's entry (a built-in returns to its default; an added kind disappears and its files fall to the next match) |
| `index [--root NAME]` | `{index}`; rebuilds and writes the cache |
| `files [--root NAME] [--kind KIND]` | `{files:[File], unavailable:[{root,path?:REL,reason}]}` from the saved index |
| `file --root NAME --path REL` | `{file:File, content:"…"}`; content is the raw file; a file over 2 MB is refused from its size, before it is read |
| `orphans [--root NAME] [--all]` | `{orphans:[File], exempt:[File], unavailable:[{root,path?:REL,reason}]}` (`--all` also lists exempt kinds) |
| `dangling [--root NAME]` | `{dangling:[Reference], unavailable:[{root,path?:REL,reason}]}` |
| `stale [--root NAME]` | `{stale:[Stale], unavailable:[{root,path?:REL,reason}]}` |
| `cost [--root NAME]` | `{roots:[Cost], unavailable:[{root,path?:REL,reason}]}`; text output gives each row's startup total, then its startup files, largest first |
| `search QUERY [--root NAME]` | `{matches:[{file:File, line:N, text:"…"}], unavailable:[{root,path?:REL,reason}]}`; case-insensitive substring over paths, titles and content, first 200 matches; one row per matching content line, and a path/title-only match uses `line:0` with the matched metadata text |
| `show --root NAME --path REL [--map]` | `{clients:N}`; POSTs `/api/show` with `view` `read` or `map`; if the server is up with 0 clients, or down, launches the window at `/read/NAME/REL` or `/map/NAME/REL` with argv `["omarchy-launch-or-focus-webapp", "Atlas Reader", URL]` — the stock command takes a window pattern before the URL and matches it against window class or title; the reader's document title is `Atlas Reader` (the native popup uses a shell layer, so the two never match each other) and the pattern focuses the open app window instead of launching a second |
| `edit --root NAME --path REL` | `{opened:true}`; runs `omarchy-launch-editor <abs>` |
| `serve` | long-running, started by `Service.qml`; `--port` for tests only |

`REL` is root-relative, may not contain `..` segments, must resolve inside the
root after canonicalisation, else `outside_roots`. `index` uses `git ls-files
--cached --others --exclude-standard` when the root contains `.git` (every
git call runs as `git --no-pager -c core.fsmonitor=false -c
log.showSignature=false`, and `git log` adds `--no-show-signature
--no-ext-diff --no-textconv`, so a repository's own config cannot run a
command while Atlas indexes), else a
walk excluding `.git node_modules .venv venv .terraform .pytest_cache
__pycache__ dist build coverage test-results .cache`. The walk:
lists any directory it meets that contains `.git` with the same `git
ls-files` call instead of walking it, so ignored files of a nested checkout
stay out, at any depth (when that call fails — a malformed `.git`, a
repository git refuses — the directory is skipped and reported `git
unavailable`, and the rest of the root is indexed); skips hidden directories (a name starting with `.`)
except one a kind's match names (by default `.claude/`, `.codex/`, `.github/`,
`.cursor/`, `.windsurf/` and `.clinerules/`, each only for the paths the
instruction kind names — a kind that names a hidden directory opens it, and inside it only
a file matched by a kind that names that directory becomes a `File`; the
catch-all `doc` and other unrelated kinds do not apply there), the others
being indexed only as their own explicit root; never enters a directory
on another filesystem than the root's (`st_dev` differs), so a drive root
stops at its mount; and for a root of `/` also skips `proc sys dev run tmp
boot lost+found`. A regular file becomes a `File` when a kind in the
effective table matches it (Definitions → Kind); the built-ins match
`.md`, `.mmd` and `.mermaid`, plus the instruction files named in full
(`.cursor/rules/*.mdc`, `.cursorrules`, `.windsurfrules`, `.clinerules`),
until the user adds a kind or widens one. Other files are served only as
images: `/raw/` returns `.png .jpg .jpeg .gif .svg .webp` anywhere in a root,
judged by the suffix of the file a symlink resolves to (`logo.png ->
secrets.yaml` is YAML, so 404 unless indexed), and any other file only when
it is indexed. No kind can match a credential-shaped file: names
`.env`, `*.env`, `.credentials.json`, `auth.json`, `.netrc`, `id_rsa*`,
`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.secret`, `*.token` are never indexed,
never served and never listed, whatever the kind table says. The names apply
to the file a symlink resolves to as well as to the listed name, so
`leak.md -> .env` is never indexed and is 403 `denied` on every route and
`denied` for `file`, `show` and `edit`. A file whose parent directory
resolves outside the root is not indexed. A document larger than 2 MB is
indexed from `stat` without being read: `bytes` is its size, `title` is the
basename, `lines` is 0 and it has no outbound references.

## Shapes

`config`: `{"version":1,"roots":[{"name":"notes","path":"/abs"}],"kinds":[KindEntry]}` at
`~/.config/omarchy-atlas/config.json`, written atomically (same-directory
temp file, fsync, rename). Invalid config fails with `config_invalid`; never
overwrite it with defaults. A root path that exists is read in canonical
form (symlinks resolved), so one directory cannot be registered twice; a
missing root keeps its stored path so that `roots` lists it and
`root-remove` removes it.

`index`: `{"version":1,"generatedAt":"ISO-8601 UTC","roots":[{"name","path","git":true,"impact":"present"|"absent"|"unreadable"}],"files":[File],"references":[Reference],"unavailable":[{root,path?:REL,reason}],"summary":{"files":N,"references":N,"orphans":N,"dangling":N,"stale":N}}`
cached at `~/.cache/omarchy-atlas/index.json`.

`unavailable` preserves stale-analysis limitations through cache: `impact
map absent`, `impact map unreadable`, `impact map exceeds 2 MB` or `impact
map exceeds 100000 references` (root only), `mixed time sources` or `no
usable source timestamp` (root and affected file). `stale` returns those same
entries; unavailable never silently means fresh. A registered root whose
directory is gone is listed here too, as `{root, reason:"root missing"}`, and
a nested checkout git could not list as `{root, path, reason:"git
unavailable"}`; these two are the entries every other collection repeats.

The shared cache represents all registered roots; a `--root` output filter
must not replace it with a partial index. Missing/corrupt cache is rebuilt
(corruption gets a diagnostic), and so is one older than 2 s, but invalid
config is never replaced. Sort
files by root/path and references by source/line/style/text. Change detection
compares semantic content, not `generatedAt`.

`File`: `{"root":"name","path":"docs/adr/0007-x.md","kind":Kind,"type":".md","title":"first H1 or basename","bytes":N,"lines":N,"time":"ISO-8601 UTC","timeSource":"git"|"mtime","inbound":N,"outbound":N,"orphan":bool,"dangling":N,"stale":Stale|null}`.
`type` is the lower-cased extension with its dot, `""` for none. `title` is
the first ATX H1 for Markdown (up to three spaces of indent, `#` and
whitespace; a closing `#` run is removed only after whitespace), else the
basename.
`Kind` (in `kinds`, the effective table): `{"id":"runbook","label":"Runbooks","colour":"yellow","match":{"paths":["runbooks/"],"extensions":[".md",".mmd",".mermaid"]},"builtin":true,"overridden":false}`.
`KindEntry` (in `config.kinds`, the user's words only): `{"id","label"?,"colour"?,"match"?:{"paths"?:[…],"extensions"?:[…]}}`.
`index` carries `"kinds":[Kind]` beside `roots` so the browser and the popup
read one table.

`Reference`: `{"from":{"root","path"},"to":{"root","path"}|null,"style":Style,"line":N,"text":"the matched text","resolved":bool,"pointer":bool}`.
`pointer` is true when `from` is an `instruction`-kind file.

`Stale`: `{"root","path","time":"…","newestSource":{"path","time"},"rule":"impact.yml#N"}`.

`Cost`: `{"root":"name","agent":Agent,"startup":[CostFile],"referenced":[CostFile],"startupBytes":N,"startupTokensApprox":N,"referencedBytes":N,"referencedTokensApprox":N}`,
where `CostFile` is `{"path","bytes":N,"lines":N,"tokensApprox":N}` and
`Agent` is one of `claude codex gemini copilot cursor windsurf cline`. A
`path` is root-relative in the row's own root, `ROOT:REL` in another
registered root, and absolute outside every root. `tokensApprox` is
`ceil(bytes/4)`, not a tokenizer; the text output, the popup and the reader
always mark it approximate (`approximate` or `~`). The two totals are never
added together.

## Definitions

**Kind**, the first entry of the effective table whose match holds for the
root-relative path — the user's entries in their order, then the built-ins
in this order. With no `match.paths`, a match holds when the path's
extension is in `match.extensions` (or the list is empty). Otherwise one of
its patterns must hold: a bare filename matches that basename at any depth,
a pattern ending in `/` matches a directory of that name at any depth
(`.claude/`), a pattern with `/` inside is a root-relative prefix
(`docs/adr/`), a leading `/` anchors a pattern at the root
(`/CONVENTIONS.md` is only the top-level file), and `*`/`**` are glob
wildcards. The extension must also be
in `match.extensions` (or the list is empty), unless the pattern itself
spells the file's name or extension — its last segment has a `.` after any
`*`, as in `.cursorrules` or `.cursor/rules/*.mdc`. A hidden directory is
opened for a kind whose pattern names it: a bare name at any depth, or a
leading segment of a root-relative pattern (`.cursor/rules/*.mdc` opens
`.cursor`). Built-ins, with their default label, colour and match (every
one lists exactly `.md`, `.mmd` and `.mermaid`; other extensions can be
added with `kind-set`):
`instruction` "Agent instructions" orange — `AGENTS.md CLAUDE.md CLAUDE.local.md codex.md GEMINI.md /CONVENTIONS.md .claude/ .codex/ .github/copilot-instructions.md .github/instructions/*.instructions.md .cursor/rules/*.mdc .cursorrules .windsurf/rules/*.md .windsurfrules .clinerules .clinerules/`
(every file in the agent table under Cost, plus Aider's `CONVENTIONS.md` at the root only — a nested one is an ordinary
document — so none is invisible or a false orphan);
`readme` "Readmes" cyan — `README.md`;
`decision` "Decisions" magenta — `docs/adr/ decisions.md`;
`runbook` "Runbooks" yellow — `runbooks/`;
`plan` "Plans" bright_blue — `plans/`;
`log` "Logs" muted — `logs/`;
`archive` "Archived" brown — `archive/ superseded/`;
`generated` "Generated" foreground — `docs/generated/`;
`diagram` "Diagrams" bright_magenta — extensions `.mmd .mermaid`;
`doc` "Documents" blue — everything else in `.md`.
In the map, an `instruction` node whose basename is `CLAUDE.md` is filled
with the theme's orange and one whose basename is `AGENTS.md` with its red,
whatever colour the kind has; this is a rule of the file name, not a kind.
Users can recolour, relabel and add kinds through the table.

**References** are extracted from Markdown files only; a tracked file of
another type has inbound references (a Markdown link to it is a resolved
`markdown` reference; an unresolved link keeps the Markdown/Mermaid suffix
rule above, so links to untracked images or data are not references) and no
outbound ones — a documented limitation, not a heuristic. The reader renders a non-Markdown `File` as highlighted plain
text (`/api/file` `content`, 2 MB cap; a file that is not valid UTF-8 is
reported as `{"binary":true,"bytes":N}` with no content).

**Reference styles**, extracted per line. Code is example text for the
link styles: a `markdown` link or `wikilink` inside a fenced code block or
an inline code span (single or multiple backticks on one line) is not a
reference and is never reported dangling; `path` tokens are extracted in
code too, because that is how these documents name files:

- `markdown`: `[text](target)` where target has no URL scheme and its path
  part ends in `.md`, `.mmd` or `.mermaid` (an `#anchor` is allowed), or
  resolves to a tracked `File` of any other type (a link to a tracked `.yml`
  is a reference; a link to `missing.png` is not a reference and never
  dangling). The link text and the target may each contain one level of
  balanced brackets (`[see [1]](a[1].md)`); a bracket pair in the target is
  never followed by `(`, so one link never runs into the next. Resolved
  relative to the referencing file's directory. Not extracted inside fenced
  code blocks or inline code spans.
- `wikilink`: `[[Name]]` or `[[Name|alias]]`. Resolved to the unique file in
  the same root whose basename is `Name.md`; zero or several candidates leave
  it unresolved. Not extracted inside fenced code blocks or inline code spans.
- `path`: any token matching `[~A-Za-z0-9_./-]+\.(md|mmd|mermaid)` that is
  not part of a `markdown` link and either contains `/` or exactly matches a
  basename in the referencing file's directory. A sentence-ending `.` after
  the extension ends the token (`see ../a.md.`); a longer extension such as
  `.md.bak` is not a match. Resolved first relative to the
  referencing file's directory, then to the root, then — for `~/` or absolute
  tokens — against every registered root. An unresolved `path` token is prose,
  not a reference; it is dropped, never reported.
- `import`: a Claude or Gemini `@path` import in an `instruction`-kind file:
  `@` at the start of a line or after whitespace, then a path whose last
  segment has an extension (`@AGENTS.md`, `@docs/rules.md`,
  `@~/.claude/mine.md`). Not extracted inside fenced code blocks or inline
  code spans. Resolved relative to the importing file's directory (`~/` from
  `HOME`, an absolute path as itself) to a `File` in any registered root.
  As for `markdown`, an import of a file that exists but is not a `File`, or
  of a missing file whose suffix is not `.md`, `.mmd` or `.mermaid`
  (`@alice.smith`), is not a reference; a missing document is unresolved, and
  dangling. The path it names is not also a `path` reference.
- `impact`: for each rule N in `docs/impact.yml` at the root, every file
  matching a `docs` glob gets an inbound reference from `docs/impact.yml` with
  `style:"impact"`, `line:N`. The file is read with `json`; if that fails the
  root's `impact` is `unreadable`, `stale` lists the root under `unavailable`,
  and no impact references exist. The same holds, with its own reason, for a
  map larger than 2 MB (refused from its size, before it is read) and for a
  map whose rules would make more than 100000 impact references in the
  root: the stale analysis is unavailable, never partial.

Impact input is `{"rules":[{"source":["src/**"],"docs":["docs/guide.md"]}]}`;
rule numbers are one-based array positions. Expand root-relative recursive
globs, intersect with discovered files and reject escaping symlinks. Sources
may have any extension; only indexed documents receive impact references.
`docs/impact.yml` is a reference source, not a File. Missing input is `absent`;
invalid JSON or rule structure is `unreadable`, never a partial guessed map.

Repeated occurrences are separate references; suppress only path tokens
already consumed by Markdown links. Resolve symlinks for containment and
physical-file deduplication, preserving instruction entry-point identity.
Files without a Git commit use mtime and must not be labelled Git time.

**Orphan**: a `File` with zero inbound references of any style whose kind is
not `instruction`, `readme` or `log`. Those kinds are entry points or
append-only by design and are listed under `exempt` only with `--all`.

**Dangling**: a `markdown`, `wikilink` or `import` reference that is unresolved.

**Stale**: a `File` with at least one inbound `impact` reference whose newest
source — the newest `time` over files matching that rule's `source` globs —
is later than the `File`'s own `time`. Times compare in UTC. Both times must
come from the same source (`git` or `mtime`); mixed sources are reported as
`unavailable` for that file rather than compared.

**Cost**: one row per root and agent, from the built-in agent table, in
this order. A row exists only when the agent has at least one `startup`
file; that file may be a global one under `HOME` alone, so an agent with a
global file has a row for every root, even a root with no instruction file.
An agent whose only files in a root are `referenced` has no row. There is no
user configuration of the table. Patterns are root-relative globs (`*` stays
in one segment, `**` crosses them); globals are under `HOME`.

| Agent | Startup | Referenced (besides mentions) | Global startup |
| --- | --- | --- | --- |
| `claude` | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/**/*.md` without a `paths` key | `**/CLAUDE.md`, `.claude/rules/**/*.md` with a `paths` key, `.claude/skills/**`, `.claude/agents/**`, `.claude/commands/**` | `~/.claude/CLAUDE.md`; `~/.claude/projects/<mangled>/memory/MEMORY.md`, first 200 lines only |
| `codex` | `AGENTS.md` | `**/AGENTS.md` | `~/.codex/AGENTS.md` |
| `gemini` | `GEMINI.md` | `**/GEMINI.md` | `~/.gemini/GEMINI.md` |
| `copilot` | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` without an `applyTo` key | `.github/instructions/*.instructions.md` with an `applyTo` key | — |
| `cursor` | `.cursor/rules/*.mdc` with `alwaysApply: true`, `.cursorrules` | the other `.cursor/rules/*.mdc` | — |
| `windsurf` | `.windsurf/rules/*.md`, `.windsurfrules` | — | — |
| `cline` | `.clinerules` as a file, or `.clinerules/*` | — | — |

A key in the table is a top-level key of the file's frontmatter: a first
line `---` (after an optional UTF-8 byte order mark), then `key: value`
lines up to the next `---`. A rule scoped by its key loads only for
matching work, so it is `referenced`.

`startup` is the root's `instruction`-kind files that match the agent's startup
patterns, then its global files that exist, then — for `claude` and
`gemini` only — every file they `@path`-import, recursively up to 5 imports
away from the entry point, as Claude Code stops (the import syntax above).
An import is followed only to a file that lies, symlinks resolved, inside a
registered root or inside `HOME`, and never to a credential-shaped file by
its own name or the name it resolves to; any other import is not followed
and not counted. `<mangled>` is the root's absolute path with every character other
than `A-Z a-z 0-9` replaced by `-`, as Claude Code names the directory.
`referenced` is what a session may load later: the resolved `markdown`,
`wikilink` and `path` targets of the startup files (and `import` targets for
agents that do not follow imports), then the root's `instruction`-kind files
that match the agent's referenced patterns. A file several agents load appears in each
of their rows; within a row a physical file appears once, in `startup` if it
is loaded there. A cost input above 2 MB is sized from `stat` without being
read: `bytes` is its size, `lines` is 0, and it contributes no imports and
no references. Global cost inputs and files imported from `HOME` outside the
roots are the explicit read-only exception to root-limited indexing; only
their size and line count are reported, and they never become
server-readable files or implicitly registered roots.

## Server

Binds `127.0.0.1:4137`. Every request must carry `Host: 127.0.0.1:<port>`
or `Host: localhost:<port>`; any other Host, or none, is 403. A `POST` must
also send `Content-Type: application/json` (otherwise 415) and is 403 when
it carries an `Origin` other than `http://127.0.0.1:<port>` or
`http://localhost:<port>`, or a `Sec-Fetch-Site` other than `same-origin`;
the CLI sends JSON with neither header. Every response carries
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
`Content-Security-Policy: frame-ancestors 'none'`; `/raw/` responses instead
carry `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'
data:; style-src 'unsafe-inline'; frame-ancestors 'none'`. A request socket
idle for 30 s is closed. Every path parameter is canonicalised and must lie
inside a registered root; otherwise 403. Path segments and query values are
percent-decoded with surrogateescape, so a filename byte that is not UTF-8
is addressed as that byte (`%FF`), matching the index's path. Containment is
decided without requiring the target to exist: an in-root path that is
absent (deleted) is 404 with `not_found`, never 403. `/api/file` and
`/raw/` refuse a file over 2 MB with 413 from its size, before reading it.
Unknown routes 404. No caching headers beyond `ETag` on `/api/file` and
`/raw/`.

| Route | Returns |
| --- | --- |
| `GET /`, `GET /read/<root>/<path>`, `GET /map`, `GET /map/<root>/<path>` | the app (`reader/index.html`); it reads view and target from the location |
| `GET /app.js`, `/app.css`, `/map.js`, `/map.css`, `/vendor/<file>` | static files from `reader/` |
| `GET /theme.css` | Palette/control CSS properties from the theme inputs below; neutral dark fallback when absent |
| `GET /api/index` | `index` (rebuilt first if older than 2 s) |
| `GET /api/file?root=&path=` | `{file:File, content, cost:[Cost], references:{inbound:[Reference], outbound:[Reference]}}`; `cost` holds the file's root/agent cost rows (the `cost --json` shape) whose `startup` lists it, when it is an `instruction`-kind file, else `[]`, and is also `[]` when a cost input cannot be read (the file still loads); non-UTF-8 content returns `binary:true, bytes` instead of `content`; over 2 MB is 413 |
| `GET /raw/<root>/<path>` | the file bytes, with a fixed content-type table keyed by the suffix of the file the path resolves to, for images (`.png .jpg .jpeg .gif .svg .webp`) anywhere in a root and for indexed files of type `.md .mmd .mermaid .txt .json .yml .yaml .toml .csv`; a non-indexed non-image file is 404 `document is not indexed`; other extensions 404; sandbox CSP above |
| `GET /api/events` | `text/event-stream`: `index` (semantic index changed), `file` (`{root,path}` whose content/existence changed), `theme` (effective theme changed), `show` (`{root,path,view}`) |
| `POST /api/show` | body `{root,path,view:"read"\|"map"}`; broadcasts `show`; returns `{clients:N}` |
| `POST /api/edit` | body `{root,path}`; runs `omarchy-launch-editor <abs>`; returns `{opened:true}` |

Lazy re-index: a request arriving more than 2 s after the last index rebuilds
first. While SSE clients are connected, refresh every 2 s even without a new
GET; idle readers must see saves. Serialise rebuilds. Emit `index` when files,
references or analyses change even if summary counts stay equal. Track
content fingerprints internally for `file` events: analytical Git time must
not hide uncommitted editor saves. A file above 2 MB is never read for its
fingerprint; its size and modification time stand for its content. Deletion emits the old root/path and the
reader reports missing. SSE must not block other clients or normal requests;
clean up disconnected clients. Subscribers count as reader instances for
`show`.

Sample theme inputs every 2 s while clients are connected, independently of
index failures. Palette comes from the top-level keys in current `colors.toml`:
the surface/text roles `background`, `dark_background`, `darker_background`,
`lighter_background`, `foreground`, `dark_foreground`, `light_foreground`,
`bright_foreground`, `accent`, `selection`, `muted` and `mode`; the named
colours `red`, `yellow`, `orange`, `green`, `cyan`, `blue`, `magenta`, `brown`;
and `bright_red`, `bright_yellow`, `bright_green`, `bright_cyan`, `bright_blue`
and `bright_magenta`. Browser CSS emits `--red`, `--yellow`, `--orange`,
`--green`, `--cyan`, `--blue`, `--magenta`, `--brown`, `--bright-red`,
`--bright-yellow`, `--bright-green`, `--bright-cyan`, `--bright-blue` and
`--bright-magenta`. Existing numbered consumers use this derivation:

| Token slot | Theme input |
| --- | --- |
| `--color-0` | `dark_background`, or `background` when absent |
| `--color-1` … `--color-6` | `red`, `green`, `yellow`, `blue`, `magenta`, `cyan` |
| `--color-7` | `light_foreground`, or `foreground` when absent |
| `--bright-color-0` | `lighter_background`, or `muted` when absent |
| `--bright-color-1` … `--bright-color-6` | `bright_red`, `bright_green`, `bright_yellow`, `bright_blue`, `bright_magenta`, `bright_cyan` |
| `--bright-color-7` | `bright_foreground` |

Browser controls read `[font] base-size`, `[spacing]` scale/control dimensions,
and `[controls]` normal, hover-cursor and focus colours/alphas from current
`shell.toml`; a `hyprland.<key>` colour resolves through `[hyprland]`.
`~/.config/omarchy/shell.toml` overrides those sections and keys. The emitted
style tokens consumed by app/map CSS are `--font-size`, `--font-size-small`,
`--font-size-large`, `--spacing`, `--spacing-small`, `--spacing-large`,
`--control-height`, `--control-padding-x`, `--control-padding-y`,
`--control-fill`, `--control-border`, `--control-fill-hover`,
`--control-border-focus`, `--control-radius` and `--font-monospace`; palette
tokens, including `--selection`, continue to come only from `colors.toml`.
Native QML uses live `Color`/`Style` directly. Browser corners sample
`hyprctl -j getoption decoration:rounding` with a short timeout and square
fallback; use the system monospace alias. No shell evaluation/config writes.
Missing or malformed individual tokens use their token defaults. Compare
effective values, including atomic file replacement, not merely a poll tick.
Absent theme uses defaults; a malformed TOML replacement retains the last good
theme with a diagnostic. On `theme`, reload CSS then redraw canvas and Mermaid
in place, preserving selected file, pins, zoom and scroll.

## Manifest and IPC

`manifest.json`: `schemaVersion` 1, `id` `io.github.broken-branch.atlas`, `kinds`
`["bar-widget","service"]`, `entryPoints` `{"barWidget":"Panel.qml",
"service":"Service.qml"}`, `barWidget.defaultSection` `"right"`. The bar
widget's IPC target is the plugin id: `omarchy-shell io.github.broken-branch.atlas
open|close|toggle`. Opening from a key is the user's own binding: Atlas
sets and installs none, and the README names the command to bind and where
(`~/.config/hypr/bindings.lua`).

## Service

`Service.qml` owns one `Quickshell.Io.Process` with
`["setpriv","--pdeathsig","TERM","python3","-B",<dir>/atlas.py,"serve"]`,
starts it on load, and restarts it 2 s after any exit, backing off to 30 s
after five exits inside a minute. It logs the child's stderr through
`console.warn` with the plugin id as prefix and has no other behaviour. When a
port bind fails the server exits 3 with a one-line reason; the service keeps
retrying on the back-off so a reboot of the shell recovers without help.
