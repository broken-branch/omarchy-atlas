#!/usr/bin/env python3
"""Markdown Atlas command-line entry point."""

from __future__ import annotations

import argparse
import http.client
import json
import os
from pathlib import Path
import sys
from typing import Any, Mapping
from urllib.parse import quote, urlsplit

import atlas_analyze
import atlas_auth
import atlas_index
import atlas_serve


VERSION = 1
COLLECTIONS = {
    "index": "rebuild the index and write the cache",
    "files": "list indexed files",
    "orphans": "list files that nothing refers to",
    "dangling": "list references whose target does not exist",
    "stale": "list files older than the sources they describe",
    "cost": "show the size of the instruction files an agent loads",
    "search": "search paths, titles and content",
}


GATES = ("orphans", "dangling", "stale")


class CliError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: {message}\n")


def _json_option(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", default=argparse.SUPPRESS,
                        help="write one JSON reply")


def parser() -> Parser:
    result = Parser(prog="atlas", description="Markdown Atlas command line", allow_abbrev=False)
    _json_option(result)
    commands = result.add_subparsers(dest="command", required=True)

    child = commands.add_parser("roots", allow_abbrev=False, help="list registered roots")
    _json_option(child)
    add = commands.add_parser("root-add", allow_abbrev=False, help="register a directory as a root")
    add.add_argument("path")
    add.add_argument("--name")
    _json_option(add)
    remove = commands.add_parser("root-remove", allow_abbrev=False, help="unregister a root")
    remove.add_argument("name")
    _json_option(remove)
    child = commands.add_parser("kinds", allow_abbrev=False, help="list the effective kind table")
    _json_option(child)
    kind_set = commands.add_parser("kind-set", allow_abbrev=False, help="create or change a kind")
    kind_set.add_argument("id")
    kind_set.add_argument("--label")
    kind_set.add_argument("--colour")
    kind_set.add_argument("--path", action="append", dest="paths")
    kind_set.add_argument("--ext", action="append", dest="extensions")
    _json_option(kind_set)
    kind_remove = commands.add_parser("kind-remove", allow_abbrev=False,
                                      help="remove a kind entry; a built-in returns to its default")
    kind_remove.add_argument("id")
    _json_option(kind_remove)

    for name, description in COLLECTIONS.items():
        child = commands.add_parser(name, allow_abbrev=False, help=description)
        if name == "search":
            child.add_argument("query")
        source = child.add_mutually_exclusive_group()
        source.add_argument("--root")
        source.add_argument("--path")
        if name == "files":
            child.add_argument("--kind")
        if name == "orphans":
            child.add_argument("--all", action="store_true")
        _json_option(child)

    for name, description in (("file", "print an indexed file"),
                              ("show", "open an indexed file in the reader"),
                              ("edit", "open an indexed file in the editor")):
        child = commands.add_parser(name, allow_abbrev=False, help=description)
        child.add_argument("--root", required=True)
        child.add_argument("--path", required=True)
        if name == "show":
            child.add_argument("--map", action="store_true")
        _json_option(child)
    serve = commands.add_parser("serve", allow_abbrev=False, help="run the reader server")
    serve.add_argument("--port", type=int, default=4137)
    return result


def _store() -> atlas_index.IndexStore:
    config_path, cache_path = atlas_index.state_paths()
    return atlas_index.IndexStore(config_path, cache_path)


def _require_roots(index: Mapping[str, Any]) -> None:
    if not index["roots"]:
        raise CliError("no_roots", "no roots are configured")


def _require_present(config: Mapping[str, Any], root: str | None) -> None:
    """A named root that is registered but gone is an error; unnamed, it is only unavailable."""
    for item in config["roots"]:
        if item["name"] == root and not Path(item["path"]).is_dir():
            raise CliError("invalid_root", f"root does not exist: {item['path']}")


def _collection_index(args: argparse.Namespace, *, rebuild: bool = False) -> dict[str, Any]:
    if args.path is not None:
        return atlas_index.index_path(args.path)
    store = _store()
    config = store.config()
    if not config["roots"]:
        raise CliError("no_roots", "no roots are configured")
    _require_present(config, args.root)
    diagnostics: list[str] = []
    index = store.rebuild() if rebuild else store.cached_or_rebuild(diagnostics)
    for diagnostic in diagnostics:
        print(diagnostic, file=sys.stderr)
    # A gate with nothing left to check must not pass.
    if args.command in GATES and not index["roots"]:
        raise CliError("invalid_root", "every registered root is missing")
    return index


def _indexed_file(root: str, relative: str) -> tuple[dict[str, Any], Path]:
    store = _store()
    _require_present(store.config(), root)
    index = store.cached_or_rebuild()
    _require_roots(index)
    view = atlas_index.filter_index(index, root)
    if not relative or "\\" in relative or Path(relative).is_absolute() or any(
            part in {"", ".", ".."} for part in relative.split("/")):
        raise CliError("outside_roots", "path is outside registered roots")
    if atlas_index.denied_path(relative):
        raise CliError("denied", "file is denied by the credential policy")
    root_path = Path(view["roots"][0]["path"])
    candidate = root_path / relative
    try:
        resolved = candidate.resolve(strict=True)
        target = resolved.relative_to(root_path.resolve(strict=True))
    except ValueError as exc:
        raise CliError("outside_roots", "path is outside registered roots") from exc
    except OSError as exc:
        raise CliError("not_found", f"file not found: {relative}") from exc
    if atlas_index.denied_path(target.as_posix()):
        raise CliError("denied", "file is denied by the credential policy")
    for file in view["files"]:
        known = root_path / file["path"]
        try:
            same = candidate == known or resolved == known.resolve(strict=True)
        except OSError:
            same = False
        if same:
            return file, candidate
    raise CliError("not_found", f"document is not indexed: {relative}")


def _read_file(root: str, relative: str) -> dict[str, Any]:
    file, path = _indexed_file(root, relative)
    try:
        with path.open("rb") as handle:
            # Refuse from the size, before reading any of it.
            if os.fstat(handle.fileno()).st_size > atlas_index.MAX_FILE_BYTES:
                raise CliError("backend_error", "file exceeds 2 MB")
            data = handle.read(atlas_index.MAX_FILE_BYTES + 1)
    except OSError as exc:
        raise CliError("not_found", f"file not found: {relative}") from exc
    if len(data) > atlas_index.MAX_FILE_BYTES:
        raise CliError("backend_error", "file exceeds 2 MB")
    return {"file": file, "content": data.decode("utf-8", "replace")}


def _server_url() -> str:
    return os.environ.get("ATLAS_SERVER_URL", "http://127.0.0.1:4137").rstrip("/")


def _server_credential() -> bytes:
    split = urlsplit(_server_url())
    if split.scheme != "http" or split.hostname != "127.0.0.1" or split.path or split.query or split.fragment or split.username or split.port is None:
        raise CliError("server_unavailable", "server URL must be a loopback HTTP origin")
    if "ATLAS_SERVER_URL" in os.environ:
        supplied = os.environ.get("ATLAS_TEST_SERVER_SECRET", "")
        if len(supplied) != 64:
            raise CliError("server_unavailable", "server override needs an explicit test credential")
        try:
            return bytes.fromhex(supplied)
        except ValueError as exc:
            raise CliError("server_unavailable", "invalid test credential") from exc
    if split.port != 4137:
        raise CliError("server_unavailable", "unexpected server port")
    return atlas_auth.server_secret(atlas_auth.secret_path(), create=True)


def _post_show(root: str, relative: str, view: str) -> int | None:
    split = urlsplit(_server_url())
    secret = _server_credential()
    connection = http.client.HTTPConnection(split.hostname, split.port, timeout=2)
    body = json.dumps({"root": root, "path": relative, "view": view}).encode("utf-8")
    try:
        connection.request("POST", (split.path.rstrip("/") + "/api/show") or "/api/show",
                           body, {"Content-Type": "application/json", "Authorization": "Bearer " + secret.hex()})
        response = connection.getresponse()
        data = response.read()
    except (OSError, http.client.HTTPException):
        return None
    finally:
        connection.close()
    if response.status == 200:
        try:
            return int(json.loads(data)["clients"])
        except (ValueError, KeyError, TypeError) as exc:
            raise CliError("backend_error", "server returned an invalid reply") from exc
    try:
        error = json.loads(data)
    except ValueError:
        error = {}
    code = error.get("code") or ("not_found" if response.status == 404 else "outside_roots" if response.status == 403 else "server_unavailable")
    raise CliError(code, error.get("error", "server request failed"))


def dispatch(args: argparse.Namespace) -> Any:
    command = args.command
    store = _store()
    if command == "roots":
        config = store.config()
        return {"config": {**config, "roots": [
            {**item, **({"missing": True} if not Path(item["path"]).is_dir() else {})}
            for item in config["roots"]]}}
    if command == "root-add":
        config = atlas_index.add_root(store.config(), args.path, args.name)
        return {"config": store.save_config(config)}
    if command == "root-remove":
        config = atlas_index.remove_root(store.config(), args.name)
        return {"config": store.save_config(config)}
    if command == "kinds":
        config = store.config()
        return {"kinds": atlas_index.effective_kinds(config.get("kinds", []))}
    if command == "kind-set":
        paths = [] if args.paths == [""] else args.paths
        extensions = [] if args.extensions == [""] else args.extensions
        config = atlas_index.set_kind(store.config(), args.id, label=args.label,
                                      colour=args.colour, paths=paths,
                                      extensions=extensions)
        return {"config": store.save_config(config)}
    if command == "kind-remove":
        config = atlas_index.remove_kind(store.config(), args.id)
        return {"config": store.save_config(config)}
    if command in COLLECTIONS:
        full = _collection_index(args, rebuild=command == "index")
        index = atlas_index.filter_index(full, args.root)
        if command == "index":
            return {"index": index}
        if command == "files":
            files = index["files"]
            if args.kind is not None:
                files = [item for item in files if item["kind"] == args.kind]
            return {"files": files, "unavailable": atlas_analyze.not_indexed(index)}
        if command == "orphans":
            return atlas_analyze.orphans(index, include_exempt=args.all)
        if command == "dangling":
            return atlas_analyze.dangling(index)
        if command == "stale":
            return atlas_analyze.stale(index)
        if command == "cost":
            # Rows come from every root, so a pointer into another root keeps its cost.
            rows = atlas_analyze.cost(full)["roots"]
            return {"roots": [row for row in rows if args.root in {None, row["root"]}],
                    "unavailable": atlas_analyze.not_indexed(index)}
        return atlas_analyze.search(index, args.query)
    if command == "file":
        return _read_file(args.root, args.path)
    if command == "edit":
        _file, path = _indexed_file(args.root, args.path)
        try:
            atlas_serve.launch_editor(path.resolve())
        except atlas_serve.ServeError as exc:
            raise CliError("server_unavailable", exc.message) from exc
        return {"opened": True}
    if command == "show":
        file, _path = _indexed_file(args.root, args.path)
        view = "map" if args.map else "read"
        clients = _post_show(args.root, file["path"], view)
        if clients is None or clients == 0:
            target = f"/{view}/{quote(args.root, safe='')}/{quote(file['path'], safe='/')}"
            secret = _server_credential()
            cache_path = atlas_index.state_paths()[1]
            bootstrap = atlas_auth.bootstrap_file(cache_path, secret, target, _server_url())
            try:
                atlas_serve.launch_webapp(bootstrap.as_uri())
            except atlas_serve.ServeError as exc:
                raise CliError("server_unavailable", exc.message) from exc
        return {"clients": 0 if clients is None else clients}
    raise CliError("backend_error", f"unsupported command: {command}")


def _cost_text(row: Mapping[str, Any]) -> list[str]:
    lines = [f"{row['root']}\t{row['agent']}\t~{row['startupTokensApprox']} tokens approximate at startup"
             f"\t{row['startupBytes']} bytes\t~{row['referencedTokensApprox']} referenced"]
    for item in sorted(row["startup"], key=lambda item: (-item["bytes"], item["path"])):
        lines.append(f"\t~{item['tokensApprox']}\t{item['path']}")
    return lines


def _unavailable_line(item: Mapping[str, Any]) -> str:
    return f"unavailable\t{item['root']}{':' + item['path'] if item.get('path') else ''}\t{item['reason']}"


def _text(command: str, data: Mapping[str, Any]) -> str:
    if command in {"roots", "root-add", "root-remove"}:
        roots = data["config"]["roots"]
        return "\n".join(f"{item['name']}\t{item['path']}" for item in roots) or "No roots configured."
    if command == "kinds":
        return "\n".join(f"{item['id']}\t{item['label']}\t{item['colour']}" for item in data["kinds"])
    if command in {"kind-set", "kind-remove"}:
        return "Updated kinds."
    if command == "index":
        summary = data["index"]["summary"]
        return "\n".join([f"Indexed {summary['files']} files, {summary['references']} references; "
                          f"{summary['orphans']} orphan, {summary['dangling']} dangling, {summary['stale']} stale."]
                         + [_unavailable_line(item) for item in atlas_analyze.not_indexed(data["index"])])
    missing = [_unavailable_line(item) for item in data.get("unavailable", [])]
    if command == "files":
        return "\n".join([f"{item['root']}:{item['path']}\t{item['kind']}" for item in data["files"]] + missing) or "No files."
    if command == "orphans":
        rows = [f"orphan\t{item['root']}:{item['path']}" for item in data["orphans"]]
        rows += [f"exempt\t{item['root']}:{item['path']}" for item in data["exempt"]]
        return "\n".join(rows + missing) or "No orphans."
    if command == "dangling":
        return "\n".join([f"{item['from']['root']}:{item['from']['path']}:{item['line']}\t{item['text']}" for item in data["dangling"]] + missing) or "No dangling references."
    if command == "stale":
        rows = [f"stale\t{item['root']}:{item['path']}\t{item['newestSource']['path']}" for item in data["stale"]]
        return "\n".join(rows + missing) or "No stale files."
    if command == "cost":
        return "\n".join([line for row in data["roots"] for line in _cost_text(row)] + missing) or "No instruction cost."
    if command == "search":
        return "\n".join([f"{item['file']['root']}:{item['file']['path']}:{item['line']}\t{item['text']}" for item in data["matches"]] + missing) or "No matches."
    if command == "file":
        return data["content"]
    if command == "show":
        return f"Reader notified ({data['clients']} clients)."
    if command == "edit":
        return "Editor opened."
    return ""


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv, namespace=argparse.Namespace(json=False))
    if arguments.command == "serve":
        try:
            atlas_serve.serve(port=arguments.port)
            return 0
        except OSError as exc:
            print(f"atlas serve: {exc}", file=sys.stderr)
            return 3
    try:
        data = dispatch(arguments)
        if arguments.json:
            reply = {"version": VERSION, "ok": True, "command": arguments.command, "data": data}
            print(json.dumps(reply, ensure_ascii=True, separators=(",", ":")))
            return 0
        output = _text(arguments.command, data)
        if output:
            print(output, end="" if output.endswith("\n") else "\n")
        if arguments.command in GATES:
            finding = bool(data[arguments.command])
            return 1 if finding else 0
        return 0
    except (CliError, atlas_index.IndexError) as exc:
        code = getattr(exc, "code", "backend_error")
        message = getattr(exc, "message", str(exc))
        if arguments.json:
            print(json.dumps({"version": VERSION, "ok": False, "command": arguments.command,
                              "code": code, "message": message}, ensure_ascii=True,
                             separators=(",", ":")))
            return 0
        print(f"atlas {arguments.command}: {message}", file=sys.stderr)
        # 1 is reserved for gate findings.
        return 3
    except Exception as exc:
        print(f"atlas {arguments.command}: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
