"""Atlas's read-only document index.

The callable boundary for command and server consumers is deliberately small:
``read_config``/``write_config`` manage the registered-root state,
``build_index`` builds an in-memory index for explicit roots, ``index_path``
does the same for an ad-hoc root without state I/O, and ``IndexStore`` combines
the registered configuration with the shared cache.  All returned values are
plain contract-shaped dictionaries and lists, so callers must not reimplement
discovery, extraction, timestamps, or finding calculations.
"""

from __future__ import annotations

import bisect
import datetime as _datetime
import fnmatch
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
from typing import Any, Iterable, Mapping
from urllib.parse import unquote


VERSION = 1
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_IMPACT_MATCHES = 100_000
# A saved index older than this is rebuilt before it is read, by the CLI and the server alike.
REFRESH_SECONDS = 2.0
DOCUMENT_SUFFIXES = {".md", ".mmd", ".mermaid"}
WALK_EXCLUDES = {
    ".git", "node_modules", ".venv", "venv", ".terraform", ".pytest_cache",
    "__pycache__", "dist", "build", "coverage", "test-results", ".cache",
}
SYSTEM_WALK_EXCLUDES = {"proc", "sys", "dev", "run", "tmp", "boot", "lost+found"}
EXEMPT_KINDS = {"instruction", "readme", "log"}
DANGLING_STYLES = {"markdown", "wikilink", "import"}
ROOT_MISSING = "root missing"
GIT_UNAVAILABLE = "git unavailable"
THEME_COLOURS = {
    "red", "yellow", "orange", "green", "cyan", "blue", "magenta", "brown",
    "bright_red", "bright_yellow", "bright_green", "bright_cyan", "bright_blue",
    "bright_magenta", "muted", "accent", "foreground",
}
_KIND_ID = re.compile(r"[a-z][a-z0-9-]*\Z")
_HEX_COLOUR = re.compile(r"#[0-9a-f]{6}\Z")
_DENIED_NAMES = {".env", ".credentials.json", "auth.json", ".netrc"}
_DENIED_GLOBS = ("*.env", "id_rsa*", "*.pem", "*.key", "*.p12", "*.pfx", "*.secret", "*.token")
_DOCUMENT_EXTENSIONS = [".md", ".mmd", ".mermaid"]
# Per agent: root-relative globs loaded when a session starts, root-relative
# globs it loads later (nested instruction files, skill and command bodies),
# files under HOME loaded at startup, and whether it follows @path imports.
# MEMORY_FILE is Claude Code's per-project auto memory, named by memory_path().
# A scoped rule matches both lists; its frontmatter decides (atlas_analyze).
MEMORY_FILE = ".claude/projects/<project>/memory/MEMORY.md"
MEMORY_LINES = 200
IMPORT_HOPS = 5
BUILTIN_AGENTS = (
    ("claude", ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md", ".claude/rules/**/*.md"],
     ["**/CLAUDE.md", ".claude/rules/**/*.md", ".claude/skills/**", ".claude/agents/**",
      ".claude/commands/**"],
     [".claude/CLAUDE.md", MEMORY_FILE], True),
    ("codex", ["AGENTS.md"], ["**/AGENTS.md"], [".codex/AGENTS.md"], False),
    ("gemini", ["GEMINI.md"], ["**/GEMINI.md"], [".gemini/GEMINI.md"], True),
    ("copilot", [".github/copilot-instructions.md", ".github/instructions/*.instructions.md"],
     [".github/instructions/*.instructions.md"], [], False),
    ("cursor", [".cursor/rules/*.mdc", ".cursorrules"], [".cursor/rules/*.mdc"], [], False),
    ("windsurf", [".windsurf/rules/*.md", ".windsurfrules"], [], [], False),
    ("cline", [".clinerules", ".clinerules/*"], [], [], False),
)
BUILTIN_KINDS = (
    ("instruction", "Agent instructions", "orange",
     ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "codex.md", "GEMINI.md", "/CONVENTIONS.md",
      ".claude/", ".codex/", ".github/copilot-instructions.md",
      ".github/instructions/*.instructions.md", ".cursor/rules/*.mdc", ".cursorrules",
      ".windsurf/rules/*.md", ".windsurfrules", ".clinerules", ".clinerules/"],
     _DOCUMENT_EXTENSIONS),
    ("readme", "Readmes", "cyan", ["README.md"], _DOCUMENT_EXTENSIONS),
    ("decision", "Decisions", "magenta", ["docs/adr/", "decisions.md"], _DOCUMENT_EXTENSIONS),
    ("runbook", "Runbooks", "yellow", ["runbooks/"], _DOCUMENT_EXTENSIONS),
    ("plan", "Plans", "bright_blue", ["plans/"], _DOCUMENT_EXTENSIONS),
    ("log", "Logs", "muted", ["logs/"], _DOCUMENT_EXTENSIONS),
    ("archive", "Archived", "brown", ["archive/", "superseded/"], _DOCUMENT_EXTENSIONS),
    ("generated", "Generated", "foreground", ["docs/generated/"], _DOCUMENT_EXTENSIONS),
    ("diagram", "Diagrams", "bright_magenta", [], [".mmd", ".mermaid"]),
    ("doc", "Documents", "blue", [], [".md"]),
)
# Link text and target admit one level of balanced brackets ([b](a[1].md)). Each
# repetition starts either with a bracket or with anything else, never both, and
# a bracket pair in a target is never followed by "(", so a target cannot run
# on into the next link: brackets and repeated links stay linear.
_MARKDOWN = re.compile(r"\[(?:[^\[\]]|\[[^\[\]]*\])*\]\(((?:[^)\[\]]|\[[^)\[\]]*\](?!\())+)\)")
_WIKILINK = re.compile(r"\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]")
_PATH = re.compile(r"(?<![~A-Za-z0-9_./-])([~A-Za-z0-9_./-]+\.(?:mermaid|mmd|md))(?![A-Za-z0-9_/-]|\.[A-Za-z0-9_/-])")
_BACKTICKS = re.compile(r"`+")
# A Claude or Gemini import: @ at the start of a line or after whitespace, then
# a path whose last segment has an extension (@AGENTS.md, @docs/a.md, @~/x.md).
_IMPORT = re.compile(r"(?<!\S)@((?:~/)?[A-Za-z0-9_./-]*\.[A-Za-z0-9]+)(?![A-Za-z0-9_/-]|\.[A-Za-z0-9_/-])")


class IndexError(Exception):
    """A predictable indexing error with a contract error code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def state_paths(environ: Mapping[str, str] | None = None) -> tuple[Path, Path]:
    """Return config and cache file paths, respecting isolated XDG state."""
    env = os.environ if environ is None else environ
    home = Path(env.get("HOME", str(Path.home())))
    config_home = Path(env.get("XDG_CONFIG_HOME", str(home / ".config")))
    cache_home = Path(env.get("XDG_CACHE_HOME", str(home / ".cache")))
    return (config_home / "omarchy-atlas" / "config.json",
            cache_home / "omarchy-atlas" / "index.json")


def private_directory(path: Path) -> None:
    """Create or narrow an Atlas-owned directory, without changing XDG parents."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise IndexError("config_invalid", "Atlas state directory has unsafe owner or type")
    if stat.S_IMODE(info.st_mode) != 0o700:
        path.chmod(0o700)


def private_file(path: Path) -> bool:
    """Validate and narrow an existing Atlas-owned regular file; reject links."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise IndexError("config_invalid", "Atlas state file has unsafe owner or type")
    if stat.S_IMODE(info.st_mode) != 0o600:
        path.chmod(0o600)
    return True


def _canonical_directory(value: str | Path) -> Path:
    path = Path(value).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise IndexError("invalid_root", f"root does not exist: {path}") from exc
    if not resolved.is_dir():
        raise IndexError("invalid_root", f"root is not a directory: {path}")
    return resolved


def _atomic_json(path: Path, value: Any) -> None:
    private_directory(path.parent)
    private_file(path)
    encoded = (json.dumps(value, ensure_ascii=True, sort_keys=True,
                          separators=(",", ":")) + "\n").encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as temporary:
            temporary.write(encoded)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
        try:
            directory = os.open(path.parent, os.O_DIRECTORY)
        except (AttributeError, OSError):
            return
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def _match_value(value: Any, *, config: bool = False) -> dict[str, list[str]]:
    if not isinstance(value, Mapping):
        raise IndexError("config_invalid" if config else "invalid_root", "kind match must be an object")
    result: dict[str, list[str]] = {}
    for key in ("paths", "extensions"):
        items = value.get(key)
        if items is None:
            continue
        if (not isinstance(items, list) or not all(isinstance(item, str) and item for item in items)):
            raise IndexError("config_invalid" if config else "invalid_root", f"kind match {key} must be a list of strings")
        if key == "extensions" and any(len(item) == 1 or not item.startswith(".") or "/" in item for item in items):
            raise IndexError("config_invalid" if config else "invalid_root", "kind extensions must be dotted extensions")
        result[key] = [item.lower() for item in items] if key == "extensions" else list(items)
    if any(key not in {"paths", "extensions"} for key in value):
        raise IndexError("config_invalid" if config else "invalid_root", "unknown kind match field")
    return result


def _kind_entry(value: Any, *, config: bool = False) -> dict[str, Any]:
    code = "config_invalid" if config else "invalid_root"
    if not isinstance(value, Mapping) or not isinstance(value.get("id"), str) or not _KIND_ID.fullmatch(value["id"]):
        raise IndexError(code, "kind id must match [a-z][a-z0-9-]*")
    result = {"id": value["id"]}
    for key in ("label", "colour"):
        item = value.get(key)
        if item is None:
            continue
        if not isinstance(item, str) or not item:
            raise IndexError(code, f"kind {key} must be non-empty text")
        if key == "colour" and item not in THEME_COLOURS and not _HEX_COLOUR.fullmatch(item):
            raise IndexError(code, "kind colour must be a theme name or #rrggbb")
        result[key] = item
    if "match" in value:
        result["match"] = _match_value(value["match"], config=config)
    if any(key not in {"id", "label", "colour", "match"} for key in value):
        raise IndexError(code, "unknown kind field")
    return result


def effective_kinds(entries: Iterable[Mapping[str, Any]] = ()) -> list[dict[str, Any]]:
    """Return user entries first, merged with the contract's built-in defaults."""
    defaults = {
        identifier: {"id": identifier, "label": label, "colour": colour,
                     "match": {"paths": list(paths), "extensions": list(extensions)},
                     "builtin": True, "overridden": False}
        for identifier, label, colour, paths, extensions in BUILTIN_KINDS
    }
    result: list[dict[str, Any]] = []
    overridden: set[str] = set()
    for raw in entries:
        entry = _kind_entry(raw, config=True)
        identifier = entry["id"]
        if identifier in overridden:
            raise IndexError("config_invalid", "kind ids must be unique")
        overridden.add(identifier)
        if identifier in defaults:
            value = {**defaults[identifier], "match": dict(defaults[identifier]["match"]), "overridden": True}
            for key in ("label", "colour", "match"):
                if key in entry:
                    value[key] = entry[key]
        else:
            if "match" not in entry or not entry["match"].get("paths") and not entry["match"].get("extensions"):
                raise IndexError("config_invalid", "a new kind needs at least one path or extension")
            value = {"id": identifier, "label": entry.get("label", identifier),
                     "colour": entry.get("colour", "foreground"), "match": entry["match"],
                     "builtin": False, "overridden": False}
        value["match"] = {"paths": list(value["match"].get("paths", [])),
                          "extensions": list(value["match"].get("extensions", []))}
        result.append(value)
    result.extend(default for identifier, default in defaults.items() if identifier not in overridden)
    return result


def denied_path(relative: str) -> bool:
    """Whether a root-relative name is never indexable or server-readable."""
    name = Path(relative).name.lower()
    return name in _DENIED_NAMES or any(fnmatch.fnmatchcase(name, pattern) for pattern in _DENIED_GLOBS)


def _validate_config(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("version") != VERSION:
        raise IndexError("config_invalid", "config must be version 1")
    roots = value.get("roots")
    if not isinstance(roots, list):
        raise IndexError("config_invalid", "config roots must be a list")
    names: set[str] = set()
    paths: set[Path] = set()
    normalized: list[dict[str, str]] = []
    for root in roots:
        if not isinstance(root, dict) or not isinstance(root.get("name"), str) or not isinstance(root.get("path"), str):
            raise IndexError("config_invalid", "each root needs a name and path")
        name = root["name"]
        if not name or name in names:
            raise IndexError("config_invalid", "root names must be unique and non-empty")
        path = Path(root["path"])
        if not path.is_absolute() or path != Path(os.path.normpath(path)):
            raise IndexError("config_invalid", f"root path must be absolute and normalized: {path}")
        # A missing root keeps its raw path so that it can still be listed and removed.
        try:
            path = path.resolve(strict=True)
        except (OSError, RuntimeError):
            pass
        if path in paths:
            raise IndexError("config_invalid", "root paths must be unique")
        names.add(name)
        paths.add(path)
        normalized.append({"name": name, "path": str(path)})
    kinds = value.get("kinds", [])
    if not isinstance(kinds, list):
        raise IndexError("config_invalid", "config kinds must be a list")
    normalized_kinds = [_kind_entry(item, config=True) for item in kinds]
    # Validate ordering, duplicate ids, and the special requirements for new kinds.
    effective_kinds(normalized_kinds)
    result: dict[str, Any] = {"version": VERSION, "roots": normalized}
    if normalized_kinds:
        result["kinds"] = normalized_kinds
    return result


def read_config(path: str | Path | None = None) -> dict[str, Any]:
    """Read and validate configured roots; a missing config is an empty one."""
    config_path = Path(path) if path is not None else state_paths()[0]
    private_directory(config_path.parent)
    if not private_file(config_path):
        return {"version": VERSION, "roots": []}
    try:
        with config_path.open(encoding="utf-8") as source:
            value = json.load(source)
    except (OSError, json.JSONDecodeError) as exc:
        raise IndexError("config_invalid", f"cannot read config: {exc}") from exc
    return _validate_config(value)


def write_config(config: Mapping[str, Any], path: str | Path | None = None) -> dict[str, Any]:
    """Validate and atomically write config, returning its canonical form."""
    normalized = _validate_config(dict(config))
    _atomic_json(Path(path) if path is not None else state_paths()[0], normalized)
    return normalized


def add_root(config: Mapping[str, Any], path: str | Path, name: str | None = None) -> dict[str, Any]:
    """Return a new config containing one canonical, explicitly opted-in root."""
    result = _validate_config(dict(config))
    root_path = _canonical_directory(path)
    root_name = name if name is not None else (root_path.name or "system")
    if not isinstance(root_name, str) or not root_name or any(item["name"] == root_name for item in result["roots"]):
        raise IndexError("invalid_root", "root name must be unique and non-empty")
    if any(Path(item["path"]) == root_path for item in result["roots"]):
        raise IndexError("invalid_root", "root path is already registered")
    result["roots"].append({"name": root_name, "path": str(root_path)})
    return result


def remove_root(config: Mapping[str, Any], name: str) -> dict[str, Any]:
    """Return a new config without the named root."""
    result = _validate_config(dict(config))
    roots = [item for item in result["roots"] if item["name"] != name]
    if len(roots) == len(result["roots"]):
        raise IndexError("not_found", f"unknown root: {name}")
    updated: dict[str, Any] = {"version": VERSION, "roots": roots}
    if result_config_kinds(result):
        updated["kinds"] = result_config_kinds(result)
    return updated


def result_config_kinds(config: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Copy optional user kind entries after config validation has canonicalised them."""
    return [dict(item) for item in config.get("kinds", [])]


def set_kind(config: Mapping[str, Any], identifier: str, *, label: str | None = None,
             colour: str | None = None, paths: list[str] | None = None,
             extensions: list[str] | None = None) -> dict[str, Any]:
    """Create or update one user kind entry without changing its order."""
    result = _validate_config(dict(config))
    entry = _kind_entry({"id": identifier}, config=True)
    current = next((dict(item) for item in result.get("kinds", []) if item["id"] == identifier), None)
    if current is None:
        current = entry
    if label is not None:
        current["label"] = label
    if colour is not None:
        current["colour"] = colour
    if paths is not None or extensions is not None:
        current["match"] = {**current.get("match", {}),
                            **({"paths": paths} if paths is not None else {}),
                            **({"extensions": extensions} if extensions is not None else {})}
    current = _kind_entry(current, config=True)
    known_builtin = identifier in {item[0] for item in BUILTIN_KINDS}
    if not known_builtin and ("match" not in current or not current["match"].get("paths") and not current["match"].get("extensions")):
        raise IndexError("config_invalid", "a new kind needs at least one path or extension")
    kinds = [current if item["id"] == identifier else item for item in result.get("kinds", [])]
    if not any(item["id"] == identifier for item in result.get("kinds", [])):
        kinds.append(current)
    updated: dict[str, Any] = {"version": VERSION, "roots": result["roots"]}
    if kinds:
        updated["kinds"] = kinds
    return _validate_config(updated)


def remove_kind(config: Mapping[str, Any], identifier: str) -> dict[str, Any]:
    """Remove a user's override or custom kind; built-ins then use their default."""
    result = _validate_config(dict(config))
    _kind_entry({"id": identifier}, config=True)
    kinds = [item for item in result.get("kinds", []) if item["id"] != identifier]
    if len(kinds) == len(result.get("kinds", [])):
        raise IndexError("not_found", f"unknown user kind: {identifier}")
    updated: dict[str, Any] = {"version": VERSION, "roots": result["roots"]}
    if kinds:
        updated["kinds"] = kinds
    return updated


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=True).relative_to(root)
        return True
    except (OSError, ValueError):
        return False


def _pattern_matches(relative: str, pattern: str) -> bool:
    # A leading / anchors a pattern at the root: /CONVENTIONS.md is only the top-level file.
    anchored = pattern.startswith("/")
    pattern = pattern.lstrip("/")
    if pattern.endswith("/"):
        directory = pattern[:-1]
        if not directory:
            return False
        if "/" in directory or anchored:
            if not any(character in directory for character in "*"):
                return relative.startswith(pattern)
            return _glob_matches(relative, directory + "/**")
        if any(character in directory for character in "*"):
            return any(_glob_matches(part, directory) for part in Path(relative).parts[:-1])
        return directory in Path(relative).parts[:-1]
    if "/" not in pattern and not anchored:
        return _glob_matches(Path(relative).name, pattern)
    if not any(character in pattern for character in "*"):
        return relative.startswith(pattern)
    return _glob_matches(relative, pattern)


def _glob_matches(value: str, pattern: str) -> bool:
    """Match root-relative globs: * stays in one path component; ** crosses it."""
    pieces: list[str] = []
    position = 0
    while position < len(pattern):
        character = pattern[position]
        if character == "*" and position + 1 < len(pattern) and pattern[position + 1] == "*":
            position += 2
            if position < len(pattern) and pattern[position] == "/":
                pieces.append("(?:.*/)?")
                position += 1
            else:
                pieces.append(".*")
            continue
        if character == "*":
            pieces.append("[^/]*")
        else:
            pieces.append(re.escape(character))
        position += 1
    return re.fullmatch("".join(pieces), value) is not None


def _names_file(pattern: str) -> bool:
    """Whether a pattern spells a file's name or extension (.cursorrules, *.mdc)."""
    return not pattern.endswith("/") and "." in pattern.rsplit("/", 1)[-1].rsplit("*", 1)[-1]


def _kind(path: str, kinds: Iterable[Mapping[str, Any]] | None = None) -> str | None:
    """Return the first effective kind matching a root-relative file path."""
    relative = Path(path).as_posix()
    extension = Path(relative).suffix.lower()
    hidden_directories = [
        Path(*Path(relative).parts[:position + 1]).as_posix()
        for position, part in enumerate(Path(relative).parts[:-1])
        if part.startswith(".")
    ]
    for kind in effective_kinds() if kinds is None else kinds:
        match = kind["match"]
        extensions = match.get("extensions", [])
        paths = match.get("paths", [])
        if any(not _kind_names_hidden_directory(kind, directory)
               for directory in hidden_directories):
            continue
        # The extension list applies unless the pattern itself names the file.
        typed = not extensions or extension in extensions
        if ((typed and not paths)
                or any(_pattern_matches(relative, pattern) and (typed or _names_file(pattern))
                       for pattern in paths)):
            return str(kind["id"])
    return None


def _is_git(root: Path) -> bool:
    return (root / ".git").exists()


def _git(root: Path, *arguments: str) -> list[str]:
    """Argv for git in a repository whose own config may come from a stranger's archive."""
    return ["git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false",
            "-C", str(root), *arguments]


def _git_paths(root: Path, *, tracked_only: bool = False) -> list[str]:
    try:
        result = subprocess.run(
            _git(root, "ls-files", "--cached", *([] if tracked_only else ["--others", "--exclude-standard"]), "-z"),
            check=False, capture_output=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise IndexError("git_error", f"cannot list git files: {exc}") from exc
    if result.returncode:
        message = result.stderr.decode("utf-8", "replace").strip() or "git ls-files failed"
        raise IndexError("git_error", message)
    return sorted(item.decode("utf-8", "surrogateescape") for item in result.stdout.split(b"\0") if item)


def _kind_names_hidden_directory(kind: Mapping[str, Any], relative: str) -> bool:
    """Whether this kind's path match explicitly names a hidden directory."""
    directory = Path(relative)
    for pattern in kind["match"].get("paths", []):
        trimmed = pattern.rstrip("/")
        anchored = trimmed.startswith("/")
        trimmed = trimmed.lstrip("/")
        if "/" not in trimmed and not anchored:
            if (any(_glob_matches(part, trimmed) for part in directory.parts) if "*" in trimmed
                    else trimmed == directory.name):
                return True
            continue
        # A root-relative pattern names each directory on the way to its
        # files: .cursor/rules/*.mdc opens .cursor.
        segments = trimmed.split("/")
        leading = segments if pattern.endswith("/") else segments[:-1]
        if (("*" in trimmed and _glob_matches(directory.as_posix(), trimmed))
                or (len(directory.parts) <= len(leading)
                    and all(segment != "**" and _glob_matches(part, segment)
                            for part, segment in zip(directory.parts, leading)))):
            return True
    return False


def _hidden_directory_named(relative: str, kinds: Iterable[Mapping[str, Any]]) -> bool:
    """Whether a kind path explicitly names this hidden directory."""
    return any(_kind_names_hidden_directory(kind, relative) for kind in kinds)


def _walk_paths(root: Path, kinds: Iterable[Mapping[str, Any]] | None = None) -> tuple[list[str], list[str]]:
    """Files to consider, and the nested checkouts git could not list."""
    found: list[str] = []
    broken: list[str] = []
    root_device = root.stat().st_dev
    kind_table = effective_kinds() if kinds is None else list(kinds)
    for directory, directories, filenames in os.walk(root, followlinks=False):
        parent = Path(directory)
        descend: list[str] = []
        for item in sorted(directories):
            candidate = parent / item
            relative = candidate.relative_to(root).as_posix()
            if ((item.startswith(".") and not _hidden_directory_named(relative, kind_table))
                    or item in WALK_EXCLUDES or candidate.is_symlink()
                    or (root == Path("/") and parent == root and item in SYSTEM_WALK_EXCLUDES)):
                continue
            try:
                if candidate.stat().st_dev != root_device:
                    continue
            except OSError:
                continue
            if _is_git(candidate):
                # A broken checkout stops only itself; walking it would index what it ignores.
                try:
                    listed = _git_paths(candidate)
                except IndexError:
                    broken.append(relative)
                    continue
                found.extend(f"{relative}/{path}" for path in listed)
            else:
                descend.append(item)
        directories[:] = descend
        prefix = parent.relative_to(root).as_posix()
        for filename in sorted(filenames):
            found.append(filename if prefix == "." else f"{prefix}/{filename}")
    return found, broken


def _discover(root: Path, kinds: Iterable[Mapping[str, Any]]) -> tuple[list[str], bool, list[str]]:
    git = _is_git(root)
    candidates, broken = (_git_paths(root), []) if git else _walk_paths(root, kinds)
    paths: list[str] = []
    # lstat follows every component but the last, so a parent directory that
    # is a symlink out of the root is contained once per directory.
    parents: dict[Path, bool] = {}
    for relative in candidates:
        candidate = root / relative
        if denied_path(relative):
            continue
        try:
            mode = candidate.lstat().st_mode
        except OSError:
            continue
        if candidate.parent not in parents:
            parents[candidate.parent] = _inside(candidate.parent, root)
        if not parents[candidate.parent]:
            continue
        if stat.S_ISLNK(mode):
            if not candidate.is_file() or not _inside(candidate, root):
                continue
            if denied_path(candidate.resolve(strict=True).relative_to(root).as_posix()):
                continue
        elif not stat.S_ISREG(mode):
            continue
        paths.append(Path(relative).as_posix())
    return sorted(set(paths)), git, broken


def _git_times(root: Path, paths: set[str]) -> tuple[dict[str, int], bool]:
    """Read commit times; report an unusable HEAD separately from an unborn one."""
    if not paths:
        return {}, False
    try:
        result = subprocess.run(
            _git(root, "log", "--no-show-signature", "--no-ext-diff", "--no-textconv",
                 "--no-renames", "--root", "--format=%x00%ct%x00", "--name-only", "-z"),
            check=False, capture_output=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise IndexError("git_error", f"cannot read git timestamp: {exc}") from exc
    if result.returncode:
        try:
            head = subprocess.run(_git(root, "rev-parse", "--verify", "--quiet", "HEAD"),
                                  check=False, capture_output=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise IndexError("git_error", f"cannot read git HEAD: {exc}") from exc
        if head.returncode:
            try:
                branch = subprocess.run(_git(root, "symbolic-ref", "--quiet", "--no-recurse", "HEAD"),
                                        check=False, capture_output=True, timeout=10)
                ref = subprocess.run(_git(root, "show-ref", "--exists", branch.stdout.decode().strip()),
                                     check=False, capture_output=True, timeout=10) if branch.returncode == 0 else None
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise IndexError("git_error", f"cannot read git branch: {exc}") from exc
            if ref is not None:
                return {}, ref.returncode != 2
        message = result.stderr.decode("utf-8", "replace").strip() or "git log failed"
        raise IndexError("git_error", message)
    tokens = result.stdout.split(b"\0")
    times: dict[str, int] = {}
    position = 0
    while position + 2 < len(tokens):
        stamp = tokens[position + 1]
        if tokens[position] != b"" or not stamp or not stamp.lstrip(b"-").isdigit():
            break
        committed = int(stamp)
        position += 3  # marker, timestamp, separator before names
        first = True
        while position < len(tokens) and tokens[position]:
            raw = tokens[position].removeprefix(b"\n") if first else tokens[position]
            path = raw.decode("utf-8", "surrogateescape")
            first = False
            if path in paths and path not in times:
                times[path] = committed
                if len(times) == len(paths):
                    return times, False
            position += 1
    return times, False


def _iso(seconds: float | int) -> str:
    valid = min(max(seconds, 0), 253402300799)
    return _datetime.datetime.fromtimestamp(valid, _datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _iso_ns(nanoseconds: int) -> str:
    seconds, fraction = divmod(min(max(nanoseconds, 0), 253402300799999999999), 1_000_000_000)
    return _iso(seconds).replace("Z", f".{fraction:09d}Z" if fraction else "Z")


def _metadata(root: Path, relative: str, git_times: Mapping[str, int]) -> dict[str, Any]:
    path = root / relative
    committed = git_times.get(relative)
    try:
        status = path.stat()
    except OSError as exc:
        raise IndexError("invalid_root", f"cannot stat {path}: {exc}") from exc
    epoch = committed if committed is not None else status.st_mtime
    return {"time": _iso(epoch), "timeSource": "git" if committed is not None else "mtime",
            "epoch": min(max(epoch, 0), 253402300799), "modified": _iso_ns(status.st_mtime_ns),
            "timestampOutOfRange": (epoch < 0 or epoch > 253402300799
                                    or status.st_mtime_ns < 0 or status.st_mtime_ns > 253402300799999999999)}


def _nvim_swaps() -> set[str]:
    swap_dir = Path(os.environ.get("HOME", str(Path.home()))) / ".local/state/nvim/swap"
    try:
        return {entry.name.rsplit(".", 1)[0] for entry in swap_dir.iterdir()
                if re.fullmatch(r"sw[a-p]", entry.name.rsplit(".", 1)[-1])}
    except OSError:
        return set()


def _editor_open(path: Path, swaps: set[str], tracked: set[str], root: Path) -> bool:
    name = path.name
    swap = path.parent / f".{name}.swp"
    lock = path.parent / f".#{name}"
    return (str(path).replace("/", "%") in swaps
            or (swap.relative_to(root).as_posix() not in tracked and swap.is_file())
            or (lock.relative_to(root).as_posix() not in tracked and os.path.lexists(lock)))


def _line_count(text: str) -> int:
    return text.count("\n") + (1 if text and not text.endswith("\n") else 0)


def _title(text: str, fallback: str) -> str:
    # String operations, not a regex: a long run of spaces must stay linear.
    for line in text.splitlines():
        heading = line.lstrip()
        if len(line) - len(heading) > 3 or not heading.startswith("#") or not heading[1:2].isspace():
            continue
        title = heading[1:].strip()
        unclosed = title.rstrip("#")
        if not unclosed or unclosed[-1].isspace():
            title = unclosed.rstrip()
        if title:
            return title
    return fallback


def _fence_state(line: str, fence: str | None) -> str | None:
    match = re.match(r"^\s*(`{3,}|~{3,})", line)
    if not match:
        return fence
    marker = match.group(1)
    if fence is None:
        return marker[0] * len(marker)
    if marker[0] == fence[0] and len(marker) >= len(fence):
        return None
    return fence


def _mask_inline_code(line: str) -> str:
    masked = list(line)
    runs = list(_BACKTICKS.finditer(line))
    # Runs by length, so an opener finds its closer without rescanning the line.
    same_length: dict[int, list[int]] = {}
    for position, run in enumerate(runs):
        same_length.setdefault(len(run.group(0)), []).append(position)
    position = 0
    while position < len(runs):
        opener = runs[position]
        candidates = same_length[len(opener.group(0))]
        following = bisect.bisect_right(candidates, position)
        if following == len(candidates):
            position += 1
            continue
        closer = runs[candidates[following]]
        masked[opener.start():closer.end()] = " " * (closer.end() - opener.start())
        position = candidates[following] + 1
    return "".join(masked)


def _document_target(token: str) -> str | None:
    target = token.strip()
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    target = unquote(target.split("#", 1)[0], encoding="utf-8", errors="surrogateescape")
    if not target or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target) or target.startswith("//"):
        return None
    return target if Path(target).suffix else None


def _document_identity(root: Path, candidate: Path, documents: Mapping[str, Any],
                       physical_paths: Mapping[Path, str] | None = None) -> str | None:
    """Resolve an existing tracked file to the one retained physical identity."""
    if not candidate.is_file() or not _inside(candidate, root):
        return None
    logical = candidate.relative_to(root).as_posix()
    if logical in documents:
        return logical
    physical = candidate.resolve(strict=True)
    if physical_paths is not None:
        return physical_paths.get(physical)
    aliases = sorted(path for path in documents if (root / path).resolve(strict=True) == physical)
    return aliases[0] if aliases else None


def _resolve_relative(root: Path, relative: str, target: str, documents: Mapping[str, Any],
                      physical_paths: Mapping[Path, str] | None = None) -> str | None:
    candidate = root / Path(relative).parent / target
    return _document_identity(root, candidate, documents, physical_paths)


def import_target(source: Path, token: str, home: Path) -> Path:
    """The file an @path import names: relative to the importing file, or ~/ or absolute."""
    return home / token[2:] if token.startswith("~/") else source.parent / token


def import_tokens(content: str) -> list[str]:
    """@path import tokens outside fenced code blocks and inline code spans."""
    tokens: list[str] = []
    fence: str | None = None
    for line in content.splitlines():
        if fence is None:
            tokens.extend(match.group(1) for match in _IMPORT.finditer(_mask_inline_code(line)))
        fence = _fence_state(line, fence)
    return tokens


def _import_reference(root_name: str, root: Path, source: Mapping[str, Any], token: str, number: int,
                      documents: Mapping[str, Any], all_roots: list[tuple[str, Path]],
                      documents_by_root: Mapping[str, Mapping[str, Any]],
                      physical_by_root: Mapping[str, Mapping[Path, str]] | None) -> dict[str, Any] | None:
    """A resolved or dangling import; like a Markdown link, an existing file no
    root indexes, or a missing file that is not a document, is not a reference."""
    candidate = import_target(root / source["path"], token, Path.home())
    resolved: tuple[str, str] | None = None
    for other_name, other_root in [(root_name, root), *all_roots]:
        relative = _document_identity(other_root, candidate,
                                      documents if other_name == root_name else documents_by_root[other_name],
                                      physical_by_root.get(other_name) if physical_by_root else None)
        if relative is not None:
            resolved = (other_name, relative)
            break
    if resolved is None and (candidate.is_file() or candidate.suffix.lower() not in DOCUMENT_SUFFIXES):
        return None
    return {"from": {"root": root_name, "path": source["path"]},
            "to": {"root": resolved[0], "path": resolved[1]} if resolved else None,
            "style": "import", "line": number, "text": "@" + token,
            "resolved": resolved is not None, "pointer": True}


def _extract_text_references(root_name: str, root: Path, source: dict[str, Any],
                             documents: dict[str, dict[str, Any]],
                             all_roots: list[tuple[str, Path]],
                             documents_by_root: Mapping[str, Mapping[str, Any]],
                             physical_by_root: Mapping[str, Mapping[Path, str]] | None = None,
                             basename_candidates: Mapping[str, list[str]] | None = None,
                             local_basenames: Mapping[str, set[str]] | None = None) -> list[dict[str, Any]]:
    references: list[dict[str, Any]] = []
    if basename_candidates is None:
        basename_candidates = {}
        for path in documents:
            basename_candidates.setdefault(Path(path).name, []).append(path)
    if local_basenames is None:
        local_basenames = {}
        for path in documents:
            local_basenames.setdefault(str(Path(path).parent), set()).add(Path(path).name)
    physical_paths = physical_by_root.get(root_name) if physical_by_root else None
    fence: str | None = None
    for number, line in enumerate(source["content"].splitlines(), start=1):
        in_fence = fence is not None
        consumed: list[tuple[int, int]] = []
        if not in_fence:
            link_line = _mask_inline_code(line)
            for match in _MARKDOWN.finditer(link_line):
                target = _document_target(match.group(1))
                if target is None:
                    continue
                consumed.append(match.span())
                resolved_path = _resolve_relative(root, source["path"], target, documents, physical_paths)
                if resolved_path is None and Path(target).suffix.lower() not in DOCUMENT_SUFFIXES:
                    continue
                references.append({
                    "from": {"root": root_name, "path": source["path"]},
                    "to": {"root": root_name, "path": resolved_path} if resolved_path else None,
                    "style": "markdown", "line": number, "text": line[match.start():match.end()],
                    "resolved": resolved_path is not None, "pointer": source["kind"] == "instruction",
                })
            if source["kind"] == "instruction":
                for match in _IMPORT.finditer(link_line):
                    consumed.append(match.span())
                    reference = _import_reference(root_name, root, source, match.group(1), number,
                                                  documents, all_roots, documents_by_root,
                                                  physical_by_root)
                    if reference is not None:
                        references.append(reference)
                consumed.sort()
            for match in _WIKILINK.finditer(link_line):
                name = match.group(1).strip()
                candidates = basename_candidates.get(f"{name}.md", [])
                resolved_path = candidates[0] if len(candidates) == 1 else None
                references.append({
                    "from": {"root": root_name, "path": source["path"]},
                    "to": {"root": root_name, "path": resolved_path} if resolved_path else None,
                    "style": "wikilink", "line": number, "text": line[match.start():match.end()],
                    "resolved": resolved_path is not None, "pointer": source["kind"] == "instruction",
                })
        # consumed spans are in line order, so one cursor finds any overlap.
        cursor = 0
        for match in _PATH.finditer(line):
            while cursor < len(consumed) and consumed[cursor][1] <= match.start():
                cursor += 1
            if cursor < len(consumed) and consumed[cursor][0] < match.end():
                continue
            token = match.group(1)
            basename = Path(token).name
            if "/" not in token and basename not in local_basenames.get(str(Path(source["path"]).parent), set()):
                continue
            resolved: tuple[str, str] | None = None
            if token.startswith("/") or token.startswith("~/"):
                absolute = Path(token).expanduser()
                for other_name, other_root in all_roots:
                    rel = _document_identity(other_root, absolute, documents_by_root[other_name],
                                             physical_by_root.get(other_name) if physical_by_root else None)
                    if rel is not None:
                        resolved = (other_name, rel)
                        break
            else:
                local = _resolve_relative(root, source["path"], token, documents, physical_paths)
                if local is None:
                    local = _resolve_relative(root, "", token, documents, physical_paths)
                if local is not None:
                    resolved = (root_name, local)
                else:
                    candidate = Path(os.path.normpath(root / Path(source["path"]).parent / token))
                    for other_name, other_root in all_roots:
                        if other_name == root_name:
                            continue
                        rel = _document_identity(other_root, candidate, documents_by_root[other_name],
                                                 physical_by_root.get(other_name) if physical_by_root else None)
                        if rel is not None:
                            resolved = (other_name, rel)
                            break
            if resolved is not None:
                target_root, target_path = resolved
                references.append({
                    "from": {"root": root_name, "path": source["path"]},
                    "to": {"root": target_root, "path": target_path},
                    "style": "path", "line": number, "text": token,
                    "resolved": True, "pointer": source["kind"] == "instruction",
                })
        fence = _fence_state(line, fence)
    return references


def _glob_paths(paths: Iterable[str], pattern: str) -> list[str]:
    return sorted(path for path in paths if _glob_matches(path, pattern))


def _impact(root_name: str, root: Path, all_paths: list[str], documents: dict[str, dict[str, Any]]) -> tuple[str, list[dict[str, Any]], dict[str, list[tuple[int, list[str]]]], list[dict[str, str]]]:
    impact_file = root / "docs" / "impact.yml"
    if not impact_file.exists():
        return "absent", [], {}, [{"root": root_name, "reason": "impact map absent"}]

    def unreadable(reason: str = "impact map unreadable") -> tuple[str, list[dict[str, Any]], dict[str, list[tuple[int, list[str]]]], list[dict[str, str]]]:
        return "unreadable", [], {}, [{"root": root_name, "reason": reason}]

    if not impact_file.is_file() or not _inside(impact_file, root):
        return unreadable()
    try:
        with impact_file.open("rb") as handle:
            if os.fstat(handle.fileno()).st_size > MAX_FILE_BYTES:
                return unreadable("impact map exceeds 2 MB")
            data = handle.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            return unreadable("impact map exceeds 2 MB")
        value = json.loads(data.decode("utf-8"))
        rules = value["rules"]
        if not isinstance(rules, list):
            raise ValueError("rules is not a list")
        for rule in rules:
            if not isinstance(rule, dict) or not all(isinstance(rule.get(key), list) and all(isinstance(item, str) for item in rule[key]) for key in ("source", "docs")):
                raise ValueError("invalid rule")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, ValueError, TypeError):
        return unreadable()
    # Repeated patterns are globbed once; the map is refused before any
    # reference is built when it would make too many.
    globbed: dict[tuple[bool, str], list[str]] = {}

    def matches(patterns: list[str], docs: bool) -> list[str]:
        for pattern in patterns:
            if (docs, pattern) not in globbed:
                globbed[(docs, pattern)] = _glob_paths(documents if docs else all_paths, pattern)
        return sorted({path for pattern in patterns for path in globbed[(docs, pattern)]})

    targets_by_rule: list[list[str]] = []
    sources_by_rule: list[list[str]] = []
    total = 0
    for rule in rules:
        targets_by_rule.append(matches(rule["docs"], True))
        sources_by_rule.append(matches(rule["source"], False))
        total += len(targets_by_rule[-1]) + len(sources_by_rule[-1])
        if total > MAX_IMPACT_MATCHES:
            return unreadable(f"impact map exceeds {MAX_IMPACT_MATCHES} matched paths")
    references: list[dict[str, Any]] = []
    source_rules: dict[str, list[tuple[int, list[str]]]] = {}
    for number, (target_paths, source_paths) in enumerate(zip(targets_by_rule, sources_by_rule), start=1):
        for target in target_paths:
            source_rules.setdefault(target, []).append((number, source_paths))
            references.append({
                "from": {"root": root_name, "path": "docs/impact.yml"},
                "to": {"root": root_name, "path": target}, "style": "impact", "line": number,
                "text": target, "resolved": True, "pointer": False,
            })
    return "present", references, source_rules, []


def _sort_references(references: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(references, key=lambda item: (item["from"]["root"], item["from"]["path"], item["line"], item["style"], item["text"]))


def build_index(roots: Iterable[Mapping[str, str]], *, kinds: Iterable[Mapping[str, Any]] = (),
                generated_at: str | None = None) -> dict[str, Any]:
    """Build a complete in-memory index for explicit canonical root mappings."""
    root_items: list[tuple[str, Path]] = []
    seen_names: set[str] = set()
    seen_paths: set[Path] = set()
    unavailable: list[dict[str, str]] = []
    for item in roots:
        name = item.get("name") if isinstance(item, Mapping) else None
        path = item.get("path") if isinstance(item, Mapping) else None
        if not isinstance(name, str) or not name or not isinstance(path, str) or name in seen_names:
            raise IndexError("invalid_root", "roots need unique names and paths")
        seen_names.add(name)
        # A registered root that has gone stops only itself.
        if not Path(path).is_dir():
            unavailable.append({"root": name, "reason": ROOT_MISSING})
            continue
        canonical = _canonical_directory(path)
        if canonical in seen_paths:
            raise IndexError("invalid_root", "root paths must be unique")
        root_items.append((name, canonical))
        seen_paths.add(canonical)
    kind_table = effective_kinds(kinds)
    nvim_swaps = _nvim_swaps()
    all_documents: dict[tuple[str, str], dict[str, Any]] = {}
    root_data: list[dict[str, Any]] = []
    per_root: dict[str, tuple[Path, list[str], bool, dict[str, dict[str, Any]],
                              dict[str, dict[str, Any]], dict[str, int]]] = {}
    extensions = {extension for kind in kind_table for extension in kind["match"].get("extensions", [])}
    extensions |= {Path(pattern.rsplit("/", 1)[-1]).suffix.lower() for kind in kind_table
                   for pattern in kind["match"].get("paths", []) if _names_file(pattern)}
    unrestricted_extension = any(not kind["match"].get("extensions") for kind in kind_table)
    for name, root in root_items:
        all_paths, git, broken = _discover(root, kind_table)
        tracked = set(_git_paths(root, tracked_only=True)) if git else set()
        unavailable.extend({"root": name, "path": path, "reason": GIT_UNAVAILABLE} for path in broken)
        metadata: dict[str, dict[str, Any]] = {}
        documents: dict[str, dict[str, Any]] = {}
        physical: set[Path] = set()
        # Prefer a real directory entry over an alias to the same physical
        # file; instruction aliases remain intentional entry points.
        document_candidates = (all_paths if unrestricted_extension else
                               [path for path in all_paths if Path(path).suffix.lower() in extensions])
        git_times, broken_head = _git_times(root, set(all_paths)) if git else ({}, False)
        if broken_head:
            unavailable.append({"root": name, "reason": GIT_UNAVAILABLE})
        for path in sorted(document_candidates, key=lambda item: ((root / item).is_symlink(), item)):
            kind = _kind(path, kind_table)
            if kind is None:
                continue
            candidate = root / path
            resolved = candidate.resolve(strict=True)
            if resolved in physical and kind != "instruction":
                continue
            physical.add(resolved)
            # Above the cap the file is a fact with its size and no content:
            # basename title, no lines counted, no references extracted.
            try:
                with candidate.open("rb") as handle:
                    size = os.fstat(handle.fileno()).st_size
                    raw = handle.read(MAX_FILE_BYTES + 1) if size <= MAX_FILE_BYTES else b""
                    if len(raw) > MAX_FILE_BYTES:  # it grew after the stat
                        size, raw = os.fstat(handle.fileno()).st_size, b""
                    elif size <= MAX_FILE_BYTES:
                        size = len(raw)
            except OSError as exc:
                raise IndexError("backend_error", f"cannot read document: {candidate}: {exc}") from exc
            metadata[path] = _metadata(root, path, git_times)
            if metadata[path]["timestampOutOfRange"]:
                unavailable.append({"root": name, "path": path, "reason": "timestamp outside supported range"})
            content = raw.decode("utf-8", "replace")
            title = _title(content, Path(path).name) if Path(path).suffix.lower() in DOCUMENT_SUFFIXES else Path(path).name
            documents[path] = {"root": name, "path": path, "kind": kind,
                               "type": Path(path).suffix.lower(), "title": title,
                               "bytes": size, "lines": _line_count(content), "time": metadata[path]["time"],
                               "timeSource": metadata[path]["timeSource"], "modified": metadata[path]["modified"],
                               "open": _editor_open(candidate, nvim_swaps, tracked, root), "content": content}
        per_root[name] = (root, all_paths, git, documents, metadata, git_times)
    references: list[dict[str, Any]] = []
    impact_rules: dict[tuple[str, str], list[tuple[int, str | None, dict[str, Any] | None, bool]]] = {}
    documents_by_root = {name: data[3] for name, data in per_root.items()}
    physical_by_root: dict[str, dict[Path, str]] = {}
    basename_by_root: dict[str, dict[str, list[str]]] = {}
    local_by_root: dict[str, dict[str, set[str]]] = {}
    for name, root in root_items:
        physical_by_root[name] = {}
        basename_by_root[name] = {}
        local_by_root[name] = {}
        for path in sorted(documents_by_root[name]):
            physical_by_root[name].setdefault((root / path).resolve(strict=True), path)
            relative = Path(path)
            basename_by_root[name].setdefault(relative.name, []).append(path)
            local_by_root[name].setdefault(str(relative.parent), set()).add(relative.name)
    for name, root in root_items:
        actual_root, all_paths, git, documents, metadata, git_times = per_root[name]
        references.extend(reference for document in documents.values()
                          if document["type"] in DOCUMENT_SUFFIXES
                          for reference in _extract_text_references(name, actual_root, document, documents, root_items,
                                                                    documents_by_root, physical_by_root,
                                                                    basename_by_root[name], local_by_root[name]))
        impact_state, impact_refs, rules, impact_unavailable = _impact(name, actual_root, all_paths, documents)
        for source in {path for entries in rules.values() for _number, paths in entries for path in paths}:
            if source not in metadata:
                metadata[source] = _metadata(actual_root, source, git_times)
                if metadata[source]["timestampOutOfRange"]:
                    unavailable.append({"root": name, "path": source, "reason": "timestamp outside supported range"})
        rule_values: dict[int, tuple[int, str | None, dict[str, Any] | None, bool]] = {}
        for entries in rules.values():
            for number, sources in entries:
                if number not in rule_values:
                    usable = [(path, metadata[path]) for path in sources if path in metadata]
                    newest_path, newest = (max(usable, key=lambda item: item[1]["epoch"])
                                           if usable else (None, None))
                    mixed = (bool(usable) and len({value["timeSource"] for _, value in usable}) > 1)
                    rule_values[number] = (number, newest_path, newest, mixed)
        references.extend(impact_refs)
        unavailable.extend(impact_unavailable)
        impact_rules.update({(name, path): [rule_values[number] for number, _ in entries]
                             for path, entries in rules.items()})
        root_data.append({"name": name, "path": str(root), "git": git, "impact": impact_state})
        all_documents.update({(name, path): document for path, document in documents.items()})
    references = _sort_references(references)
    inbound: dict[tuple[str, str], int] = {key: 0 for key in all_documents}
    outbound: dict[tuple[str, str], int] = {key: 0 for key in all_documents}
    dangling: dict[tuple[str, str], int] = {key: 0 for key in all_documents}
    for reference in references:
        source_key = (reference["from"]["root"], reference["from"]["path"])
        target = reference["to"]
        if source_key in outbound:
            outbound[source_key] += 1
        if target is not None and (target["root"], target["path"]) in inbound:
            inbound[(target["root"], target["path"])] += 1
        if target is None and reference["style"] in DANGLING_STYLES and source_key in dangling:
            dangling[source_key] += 1
    stale_count = 0
    files: list[dict[str, Any]] = []
    for key in sorted(all_documents):
        document = all_documents[key]
        stale: dict[str, Any] | None = None
        for number, newest_path, newest, mixed in impact_rules.get(key, []):
            if newest is None:
                unavailable.append({"root": key[0], "path": key[1], "reason": "no usable source timestamp"})
                continue
            if mixed or newest["timeSource"] != document["timeSource"]:
                unavailable.append({"root": key[0], "path": key[1], "reason": "mixed time sources"})
                continue
            if newest["epoch"] > _datetime.datetime.fromisoformat(document["time"].replace("Z", "+00:00")).timestamp():
                candidate = {"root": key[0], "path": key[1], "time": document["time"],
                             "newestSource": {"path": newest_path, "time": newest["time"]},
                             "rule": f"impact.yml#{number}"}
                if stale is None or candidate["newestSource"]["time"] > stale["newestSource"]["time"]:
                    stale = candidate
        file_value = {field: document[field] for field in ("root", "path", "kind", "type", "title", "bytes", "lines", "time", "timeSource", "modified", "open")}
        file_value.update({"inbound": inbound[key], "outbound": outbound[key],
                           "orphan": inbound[key] == 0 and document["kind"] not in EXEMPT_KINDS,
                           "dangling": dangling[key], "stale": stale})
        stale_count += stale is not None
        files.append(file_value)
    unavailable = sorted({(item["root"], item.get("path"), item["reason"]) for item in unavailable}, key=lambda item: (item[0], item[1] or "", item[2]))
    unavailable_values = [{"root": root, **({"path": path} if path is not None else {}), "reason": reason}
                          for root, path, reason in unavailable]
    return {"version": VERSION, "generatedAt": generated_at or _iso(_datetime.datetime.now(_datetime.timezone.utc).timestamp()),
            "roots": sorted(root_data, key=lambda item: item["name"]), "kinds": kind_table,
            "files": files, "references": references,
            "unavailable": unavailable_values,
            "summary": {"files": len(files), "references": len(references),
                        "orphans": sum(file["orphan"] for file in files),
                        "dangling": sum(file["dangling"] for file in files), "stale": stale_count}}


def index_path(path: str | Path, *, generated_at: str | None = None) -> dict[str, Any]:
    """Build an ad-hoc index without reading or writing config/cache state."""
    root = _canonical_directory(path)
    return build_index([{"name": root.name, "path": str(root)}], generated_at=generated_at)


def _validate_index(value: Any) -> dict[str, Any]:
    if (not isinstance(value, dict) or value.get("version") != VERSION
            or not isinstance(value.get("generatedAt"), str)
            or not isinstance(value.get("roots"), list)
            or not isinstance(value.get("kinds"), list)
            or not isinstance(value.get("files"), list)
            or not isinstance(value.get("references"), list)
            or not isinstance(value.get("unavailable"), list)
            or not isinstance(value.get("summary"), dict)):
        raise ValueError("not an Atlas version 1 index")
    return value


def read_cache(path: str | Path | None = None, diagnostics: list[str] | None = None) -> dict[str, Any] | None:
    """Read a valid cache, reporting corruption to an optional diagnostics list."""
    cache_path = Path(path) if path is not None else state_paths()[1]
    private_directory(cache_path.parent)
    private_file(cache_path)
    try:
        with cache_path.open(encoding="utf-8") as source:
            return _validate_index(json.load(source))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        if diagnostics is not None:
            diagnostics.append(f"cache corrupt: {cache_path}: {exc}")
        return None


def write_cache(index: Mapping[str, Any], path: str | Path | None = None) -> None:
    """Atomically write a contract-shaped shared cache."""
    _atomic_json(Path(path) if path is not None else state_paths()[1], _validate_index(dict(index)))


def semantic_index(index: Mapping[str, Any]) -> dict[str, Any]:
    """Return the semantic portion used by refresh callers to detect changes."""
    return {key: value for key, value in index.items() if key != "generatedAt"}


def filter_index(index: Mapping[str, Any], root: str | None = None) -> dict[str, Any]:
    """Return a root-filtered view without mutating or replacing the full cache.

    CLI and HTTP consumers use this after ``cached_or_rebuild``.  The values
    attached to Files were calculated in the all-root index and are never
    recalculated from a partial view.
    """
    checked = _validate_index(dict(index))
    if root is None:
        return checked
    if root not in {item.get("name") for item in checked["roots"]}:
        raise IndexError("not_found", f"unknown root: {root}")
    files = [item for item in checked["files"] if item.get("root") == root]
    references = [item for item in checked.get("references", []) if item.get("from", {}).get("root") == root]
    unavailable = [item for item in checked.get("unavailable", []) if item.get("root") == root]
    return {**checked, "roots": [item for item in checked["roots"] if item.get("name") == root],
            "files": files, "references": references, "unavailable": unavailable,
            "summary": {"files": len(files), "references": len(references),
                        "orphans": sum(item.get("orphan", False) for item in files),
                        "dangling": sum(item.get("dangling", 0) for item in files),
                        "stale": sum(item.get("stale") is not None for item in files)}}


def _stat_signature(path: Path, *, follow: bool = True) -> tuple[int, int] | None:
    try:
        status = path.stat() if follow else path.lstat()
        return status.st_mtime_ns, status.st_size
    except OSError:
        return None


class IndexStore:
    """Registered-root state facade; no CLI or HTTP behaviour."""

    def __init__(self, config_path: str | Path | None = None, cache_path: str | Path | None = None):
        defaults = state_paths()
        self.config_path = Path(config_path) if config_path is not None else defaults[0]
        self.cache_path = Path(cache_path) if cache_path is not None else defaults[1]

    def config(self) -> dict[str, Any]:
        return read_config(self.config_path)

    def save_config(self, config: Mapping[str, Any]) -> dict[str, Any]:
        return write_config(config, self.config_path)

    def rebuild(self) -> dict[str, Any]:
        config = self.config()
        index = build_index(config["roots"], kinds=config.get("kinds", []))
        write_cache(index, self.cache_path)
        return index

    def signature(self) -> tuple[Any, ...]:
        """Cheap inputs that can change discovery, facts, or open state."""
        config = self.config()
        kinds = effective_kinds(config.get("kinds", []))
        items: list[Any] = [json.dumps(config, sort_keys=True), tuple(sorted(_nvim_swaps()))]
        for entry in config["roots"]:
            root = Path(entry["path"])
            if not root.is_dir():
                items.append((entry["name"], "missing"))
                continue
            paths, git, broken = _discover(root, kinds)
            items.append((entry["name"], str(root), git, tuple(broken)))
            if git:
                try:
                    result = subprocess.run(_git(root, "rev-parse", "--git-path", "index", "HEAD"),
                                            check=False, capture_output=True, timeout=10)
                except (OSError, subprocess.TimeoutExpired) as exc:
                    raise IndexError("git_error", f"cannot read git state: {exc}") from exc
                values = result.stdout.decode("utf-8", "surrogateescape").splitlines()
                index_path = Path(values[0]) if values else root / ".git/index"
                if not index_path.is_absolute():
                    index_path = root / index_path
                items.append((result.returncode, values[1:] if len(values) > 1 else [],
                              _stat_signature(index_path)))
            for relative in paths:
                candidate = root / relative
                items.append((relative, _stat_signature(candidate, follow=False),
                              _stat_signature(candidate)))
            items.append(("docs/impact.yml", _stat_signature(root / "docs/impact.yml")))
            for relative in paths:
                candidate = root / relative
                items.append((relative, _stat_signature(candidate.parent / f".{candidate.name}.swp"),
                              _stat_signature(candidate.parent / f".#{candidate.name}", follow=False)))
        return tuple(items)

    def cached_or_rebuild(self, diagnostics: list[str] | None = None) -> dict[str, Any]:
        """Return the full cache, rebuilding all roots when it is absent, corrupt,
        older than REFRESH_SECONDS, or for another root list or kind table."""
        config = self.config()
        cached = read_cache(self.cache_path, diagnostics)
        # The index lists roots by name; the config keeps the order they were added.
        # A missing root is absent from the index, so its return rebuilds; it is
        # listed as unavailable, so its going rebuilds too.
        expected_roots = sorted((item["name"], item["path"]) for item in config["roots"]
                                if Path(item["path"]).is_dir())
        expected_missing = sorted(item["name"] for item in config["roots"] if not Path(item["path"]).is_dir())
        cached_roots = ([] if cached is None else
                        [(item.get("name"), item.get("path")) for item in cached.get("roots", [])])
        cached_missing = ([] if cached is None else
                          sorted(item.get("root") for item in cached["unavailable"]
                                 if item.get("reason") == ROOT_MISSING))
        expected_kinds = effective_kinds(config.get("kinds", []))
        try:
            age = time.time() - self.cache_path.stat().st_mtime
        except OSError:
            age = REFRESH_SECONDS + 1
        if (cached is None or age > REFRESH_SECONDS or cached_roots != expected_roots
                or cached_missing != expected_missing or cached.get("kinds") != expected_kinds):
            index = build_index(config["roots"], kinds=config.get("kinds", []))
            write_cache(index, self.cache_path)
            return index
        return cached
