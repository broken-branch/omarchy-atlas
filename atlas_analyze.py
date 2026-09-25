"""Derived Atlas views that do not duplicate indexing analysis."""

from __future__ import annotations

import math
import os
import re
from pathlib import Path
from typing import Any, Mapping

import atlas_index


MAX_SEARCH_MATCHES = 200


def orphans(index: Mapping[str, Any], *, include_exempt: bool = False) -> dict[str, Any]:
    """Return orphan facts already calculated by the indexer."""
    files = list(index["files"])
    result = {"orphans": [item for item in files if item["orphan"]]}
    result["exempt"] = ([item for item in files if item["kind"] in atlas_index.EXEMPT_KINDS
                         and item["inbound"] == 0] if include_exempt else [])
    result["unavailable"] = not_indexed(index)
    return result


def not_indexed(index: Mapping[str, Any]) -> list[dict[str, str]]:
    """Registered roots whose directory is gone and nested checkouts git could
    not list, as the index records them."""
    return [item for item in index.get("unavailable", [])
            if item["reason"] in {atlas_index.ROOT_MISSING, atlas_index.GIT_UNAVAILABLE}]


def dangling(index: Mapping[str, Any]) -> dict[str, Any]:
    """Return unresolved link facts already calculated by the indexer."""
    return {"dangling": [item for item in index["references"]
                         if item["style"] in atlas_index.DANGLING_STYLES and not item["resolved"]],
            "unavailable": not_indexed(index)}


def stale(index: Mapping[str, Any]) -> dict[str, Any]:
    """Return stale facts and the indexer's explicit unavailable reasons."""
    return {"stale": [item["stale"] for item in index["files"] if item["stale"] is not None],
            "unavailable": list(index.get("unavailable", []))}


def _roots(index: Mapping[str, Any]) -> dict[str, Path]:
    return {item["name"]: Path(item["path"]) for item in index["roots"]}


def _document_path(index: Mapping[str, Any], file: Mapping[str, Any]) -> Path:
    root = _roots(index).get(file["root"])
    if root is None:
        raise atlas_index.IndexError("not_found", f"unknown root: {file['root']}")
    candidate = root / file["path"]
    try:
        candidate.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as exc:
        raise atlas_index.IndexError("not_found", f"file unavailable: {file['root']}/{file['path']}") from exc
    if not candidate.is_file():
        raise atlas_index.IndexError("not_found", f"file unavailable: {file['root']}/{file['path']}")
    return candidate


def search(index: Mapping[str, Any], query: str) -> dict[str, Any]:
    """Case-insensitive path/title/content search, capped at 200 rows."""
    needle = query.casefold()
    matches: list[dict[str, Any]] = []
    for file in index["files"]:
        path_match = needle in file["path"].casefold()
        title_match = needle in file["title"].casefold()
        try:
            text = _document_path(index, file).read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            raise atlas_index.IndexError("not_found", f"file unavailable: {file['root']}/{file['path']}") from exc
        content_rows = [(number, line) for number, line in enumerate(text.splitlines(), start=1)
                        if needle in line.casefold()]
        if content_rows:
            for number, line in content_rows:
                matches.append({"file": file, "line": number, "text": line})
                if len(matches) == MAX_SEARCH_MATCHES:
                    return {"matches": matches, "unavailable": not_indexed(index)}
        elif path_match or title_match:
            matches.append({"file": file, "line": 0,
                            "text": file["path"] if path_match else file["title"]})
            if len(matches) == MAX_SEARCH_MATCHES:
                break
    return {"matches": matches, "unavailable": not_indexed(index)}


def _line_count(data: bytes) -> int:
    return data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)


def memory_path(home: Path, root: Path) -> Path:
    """Claude Code's auto memory for a project: every non-alphanumeric character becomes -."""
    return home / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(root)) / "memory" / "MEMORY.md"


def _cost_file(path: Path, display: str, max_lines: int | None = None) -> tuple[dict[str, Any], str]:
    """Size one cost input and return the text it contributes; above 2 MB, from stat alone."""
    try:
        with path.open("rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            data = handle.read(atlas_index.MAX_FILE_BYTES + 1) if size <= atlas_index.MAX_FILE_BYTES else b""
    except OSError as exc:
        raise atlas_index.IndexError("not_found", f"cost input unavailable: {path}") from exc
    if size > atlas_index.MAX_FILE_BYTES or len(data) > atlas_index.MAX_FILE_BYTES:
        return {"path": display, "bytes": size, "lines": 0, "tokensApprox": math.ceil(size / 4)}, ""
    if max_lines is not None:
        end = -1
        for _line in range(max_lines):
            end = data.find(b"\n", end + 1)
            if end < 0:
                break
        if end >= 0:
            data = data[:end + 1]
    return ({"path": display, "bytes": len(data), "lines": _line_count(data),
             "tokensApprox": math.ceil(len(data) / 4)}, data.decode("utf-8", "replace"))


def _frontmatter(text: str) -> dict[str, str]:
    """Top-level keys of a leading --- block, after any UTF-8 byte order mark."""
    lines = text.removeprefix("\ufeff").splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    keys: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        key, colon, value = line.partition(":")
        if colon and not line[:1].isspace():
            keys[key.strip()] = value.strip()
    return keys


def _scoped(agent: str, relative: str, text: str) -> bool:
    """Whether a rule file loads only for matching work, so it is referenced, not startup:
    a Cursor rule without alwaysApply: true, a Claude rule with paths, a Copilot
    instructions file with applyTo."""
    keys = _frontmatter(text)
    if agent == "cursor" and relative.endswith(".mdc"):
        return keys.get("alwaysApply") != "true"
    if agent == "claude" and relative.startswith(".claude/rules/"):
        return "paths" in keys
    if agent == "copilot" and relative.startswith(".github/instructions/"):
        return "applyTo" in keys
    return False


def _physical(path: Path) -> tuple[int, int] | str:
    try:
        stat = path.stat()
        return stat.st_dev, stat.st_ino
    except OSError:
        return str(path.resolve(strict=False))


def _global_pointer_targets(path: Path, content: str, index: Mapping[str, Any], roots: Mapping[str, Path],
                            styles: set[str]) -> list[tuple[str, str]]:
    """Extract references from the capped text of a file outside the index without adding it to the index."""
    documents_by_root: dict[str, dict[str, dict[str, Any]]] = {
        name: {} for name in roots
    }
    merged_documents: dict[str, dict[str, Any]] = {}
    merged_identities: dict[str, tuple[str, str]] = {}
    for file in index["files"]:
        root_name, relative = file["root"], file["path"]
        documents_by_root[root_name][relative] = file
        absolute = roots[root_name] / relative
        merged_path = absolute.as_posix().lstrip("/")
        merged_documents.setdefault(merged_path, file)
        merged_identities.setdefault(merged_path, (root_name, relative))

    try:
        source_path = path.resolve(strict=True).as_posix().lstrip("/")
    except OSError as exc:
        raise atlas_index.IndexError("not_found", f"cost input unavailable: {path}") from exc
    source = {"root": "__global__", "path": source_path,
              "kind": "instruction", "content": content}
    root_items = list(roots.items())
    references = atlas_index._extract_text_references(
        "__global__", Path("/"), source, merged_documents,
        root_items, documents_by_root,
    )

    targets: list[tuple[str, str]] = []
    for reference in references:
        target = reference["to"]
        if target is None or reference["style"] not in styles:
            continue
        if target["root"] == "__global__":
            identity = merged_identities.get(target["path"])
            if identity is None:
                continue
        else:
            identity = (target["root"], target["path"])
        if reference["style"] == "path" and not Path(reference["text"]).is_absolute() \
                and not reference["text"].startswith("~/"):
            intended = (path.parent / reference["text"]).resolve(strict=False)
            actual = (roots[identity[0]] / identity[1]).resolve(strict=False)
            if intended != actual:
                continue
        targets.append(identity)
    return targets


def _display(path: Path, identity: tuple[str, str] | None, root_name: str,
             roots: Mapping[str, Path]) -> str:
    """Root-relative in the row's own root, root:path in another, else absolute."""
    if identity is None:
        normal = Path(os.path.normpath(path))
        for name, root in roots.items():
            if normal.is_relative_to(root):
                identity = (name, normal.relative_to(root).as_posix())
                break
        else:
            return str(normal)
    return identity[1] if identity[0] == root_name else f"{identity[0]}:{identity[1]}"


def _followed(target: Path, roots: Mapping[str, Path], home: Path) -> bool:
    """An import is followed to a file inside a registered root or HOME, never to a credential-shaped one."""
    try:
        resolved = target.resolve(strict=True)
    except (OSError, RuntimeError):
        return False
    return (resolved.is_file() and not atlas_index.denied_path(target.name)
            and not atlas_index.denied_path(resolved.name)
            and any(resolved.is_relative_to(place) for place in [*roots.values(), home.resolve()]))


def cost(index: Mapping[str, Any], *, environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Per root and agent, the instruction files loaded at startup and those referenced."""
    env = os.environ if environ is None else environ
    home = Path(env.get("HOME", str(Path.home())))
    roots = _roots(index)
    indexed = {_physical(roots[item["root"]] / item["path"]): (item["root"], item["path"])
               for item in reversed(index["files"])}
    outbound: dict[tuple[str, str], list[tuple[str, str, str]]] = {}
    for reference in index["references"]:
        if reference["to"] is not None and reference["style"] != "impact":
            outbound.setdefault((reference["from"]["root"], reference["from"]["path"]), []).append(
                (reference["style"], reference["to"]["root"], reference["to"]["path"]))

    rows: list[dict[str, Any]] = []
    for root_item in index["roots"]:
        root_name = root_item["name"]
        root_path = roots[root_name]
        root_files = [item["path"] for item in index["files"]
                      if item["root"] == root_name and item["kind"] == "instruction"]
        for agent, startup_globs, referenced_globs, global_files, imports in atlas_index.BUILTIN_AGENTS:
            # Each input: its path, its index identity when it is a File, a line
            # limit, and how many imports away from an entry point it is.
            queue: list[tuple[Path, tuple[str, str] | None, int | None, int]] = [
                (root_path / path, (root_name, path), None, 0) for path in root_files
                if any(atlas_index._glob_matches(path, pattern) for pattern in startup_globs)]
            for relative in global_files:
                memory = relative == atlas_index.MEMORY_FILE
                path = memory_path(home, root_path) if memory else home / relative
                if path.is_file():
                    queue.append((path, None, atlas_index.MEMORY_LINES if memory else None, 0))

            # Startup: the entry points, then every file they import, up to IMPORT_HOPS away.
            startup: list[tuple[Path, tuple[str, str] | None, dict[str, Any], str]] = []
            seen: set[tuple[int, int] | str] = set()
            while queue:
                path, identity, max_lines, hops = queue.pop(0)
                physical = _physical(path)
                if physical in seen:
                    continue
                seen.add(physical)
                entry, text = _cost_file(path, _display(path, identity, root_name, roots), max_lines)
                if hops == 0 and identity is not None and _scoped(agent, identity[1], text):
                    seen.discard(physical)
                    continue
                startup.append((path, identity, entry, text))
                if not imports or hops == atlas_index.IMPORT_HOPS:
                    continue
                for token in atlas_index.import_tokens(text):
                    target = atlas_index.import_target(path, token, home)
                    if _followed(target, roots, home):
                        queue.append((target, indexed.get(_physical(target)), None, hops + 1))

            # Referenced: what startup files mention, nested instruction files,
            # and bodies loaded on demand.
            styles = {"markdown", "wikilink", "path"} | (set() if imports else {"import"})
            candidates: list[tuple[str, str]] = []
            for path, identity, _entry, text in startup:
                if identity is None:
                    candidates.extend(_global_pointer_targets(path, text, index, roots, styles))
                else:
                    candidates.extend((target_root, target_path) for style, target_root, target_path
                                      in outbound.get(identity, []) if style in styles)
            candidates.extend((root_name, path) for path in root_files
                              if any(atlas_index._glob_matches(path, pattern) for pattern in referenced_globs))
            referenced: list[dict[str, Any]] = []
            for target_root, target_path in candidates:
                if target_root not in roots:  # another root, outside a --root view
                    continue
                path = roots[target_root] / target_path
                physical = _physical(path)
                if physical in seen:
                    continue
                seen.add(physical)
                referenced.append(_cost_file(path, _display(path, (target_root, target_path),
                                                            root_name, roots))[0])

            # A row is an agent that loads something at startup, from the root or HOME.
            if not startup:
                continue
            startup_entries = [entry for _path, _identity, entry, _text in startup]
            rows.append({"root": root_name, "agent": agent,
                         "startup": startup_entries, "referenced": referenced,
                         "startupBytes": sum(item["bytes"] for item in startup_entries),
                         "startupTokensApprox": sum(item["tokensApprox"] for item in startup_entries),
                         "referencedBytes": sum(item["bytes"] for item in referenced),
                         "referencedTokensApprox": sum(item["tokensApprox"] for item in referenced)})
    return {"roots": rows, "unavailable": not_indexed(index)}
