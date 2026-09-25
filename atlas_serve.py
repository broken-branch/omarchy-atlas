"""Loopback HTTP, SSE, theme, and launcher support for Atlas.

This module deliberately has no import-time side effects.  ``create_server``
is also the test seam: callers can supply temporary state and theme paths and
ask the OS for an ephemeral port.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import queue
import re
import subprocess
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Mapping, Sequence
from urllib.parse import parse_qs, unquote, urlsplit

import atlas_index
import atlas_analyze

try:  # Python 3.11+, which is part of Atlas's standard-library baseline.
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - makes failure explicit on old Python.
    tomllib = None  # type: ignore[assignment]


INDEX_INTERVAL = atlas_index.REFRESH_SECONDS
DELIVERY_TIMEOUT = 0.5
LAUNCH_TIMEOUT = 10.0
STYLE_TIMEOUT = 0.5
MAX_FILE_BYTES = 2 * 1024 * 1024
REQUEST_TIMEOUT = 30.0
APP_ROOT = Path(__file__).resolve().parent
PAGE_POLICY = "frame-ancestors 'none'"
# A /raw response is a stranger's file: it renders as an image or text but
# never runs script in the Atlas origin, even when opened as a page.
RAW_POLICY = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'"
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}

RAW_TYPES = {
    ".md": "text/markdown; charset=utf-8",
    ".mmd": "text/plain; charset=utf-8",
    ".mermaid": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
    ".toml": "application/toml; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
}
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}

FALLBACK_THEME = {
    "background": "#1e1e2e", "foreground": "#cdd6f4", "accent": "#89b4fa",
    "muted": "#6c7086", "selection": "#45475a", "mode": "dark",
    "red": "#f38ba8", "yellow": "#f9e2af", "orange": "#eb927b",
    "green": "#a6e3a1", "cyan": "#94e2d5", "blue": "#89b4fa",
    "magenta": "#f5c2e7", "brown": "#75493d",
    "bright_red": "#f38ba8", "bright_yellow": "#f9e2af",
    "bright_green": "#a6e3a1", "bright_cyan": "#94e2d5",
    "bright_blue": "#89b4fa", "bright_magenta": "#f5c2e7",
    "bright_color7": "#a6adc8",
}


class ServeError(Exception):
    """A predictable HTTP request failure."""

    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


def _command(value: str | Sequence[str]) -> list[str]:
    return [value] if isinstance(value, str) else list(value)


def _run_launcher(command: str | Sequence[str], *arguments: str, timeout: float = LAUNCH_TIMEOUT) -> None:
    """Run a desktop launcher as argv, never through a shell."""
    try:
        result = subprocess.run(_command(command) + list(arguments), check=False, timeout=timeout,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ServeError(HTTPStatus.BAD_GATEWAY, f"launcher unavailable: {exc}") from exc
    if result.returncode:
        raise ServeError(HTTPStatus.BAD_GATEWAY, "launcher failed")


def launch_webapp(url: str, command: str | Sequence[str] = "omarchy-launch-or-focus-webapp") -> None:
    """Launch/focus the reader using its window pattern and URL arguments."""
    _run_launcher(command, "Atlas Reader", url)


def launch_editor(path: str | Path, command: str | Sequence[str] = "omarchy-launch-editor") -> None:
    """Open an already-contained file in the configured editor."""
    _run_launcher(command, str(path))


def _inside(candidate: Path, root: Path) -> bool:
    try:
        candidate.resolve(strict=True).relative_to(root.resolve(strict=True))
        return True
    except (OSError, ValueError):
        return False


def _safe_relative(value: str) -> Path:
    if not value or "\\" in value:
        raise ServeError(HTTPStatus.FORBIDDEN, "path is outside registered roots")
    pure = PurePosixPath(value)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise ServeError(HTTPStatus.FORBIDDEN, "path is outside registered roots")
    return Path(*pure.parts)


def _safe_url_parts(raw_path: str) -> list[str]:
    parts: list[str] = []
    for raw in raw_path.split("/"):
        if not raw:
            continue
        # surrogateescape inverts os.fsdecode, so a non-UTF-8 filename byte
        # sent as %XX names the same file the index listed.
        value = unquote(raw, errors="surrogateescape")
        if not value or value in {".", ".."} or "/" in value or "\\" in value:
            raise ServeError(HTTPStatus.FORBIDDEN, "path is outside registered roots")
        parts.append(value)
    return parts


def _etag(data: bytes) -> str:
    return '"' + hashlib.sha256(data).hexdigest() + '"'


def _safe_css(value: str) -> bool:
    return bool(value) and not any(character in value for character in "\r\n;{}")


def _read_toml(path: Path) -> dict[str, Any]:
    if tomllib is None:
        raise ValueError("Python 3.11 tomllib is required")
    with path.open("rb") as source:
        decoded = tomllib.load(source)
    if not isinstance(decoded, Mapping):
        raise ValueError("theme input is not a table")
    return dict(decoded)


def _merge_toml(base: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        current = merged.get(key)
        if isinstance(current, Mapping) and isinstance(value, Mapping):
            merged[key] = _merge_toml(current, value)
        else:
            merged[key] = value
    return merged


def _section(document: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    value = document.get(name)
    return value if isinstance(value, Mapping) else {}


def _first(values: Mapping[str, Any], *names: str) -> str | None:
    for name in names:
        result = values.get(name)
        if isinstance(result, str):
            result = result.strip()
            if _safe_css(result):
                return result
    return None


def _css_name(name: str) -> str:
    return re.sub(r"[^a-z0-9-]", "-", name.replace("_", "-").lower())


def _number(value: Any, fallback: float, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return fallback
    number = float(value)
    return fallback if minimum is not None and number < minimum else number


def _rounded(value: float) -> int:
    return max(0, math.floor(value + 0.5))


def _spacing_token(spacing: Mapping[str, Any], name: str, fallback: int, scale: float) -> int:
    value = spacing.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        value = fallback * scale
    return _rounded(float(value))


def _rgba(value: Any, alpha: float, fallback: str) -> str:
    candidate = value.strip() if isinstance(value, str) else ""
    match = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", candidate)
    if match is None:
        candidate = fallback
        match = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", candidate)
    if match is None:
        candidate = FALLBACK_THEME["foreground"]
        match = re.fullmatch(r"#([0-9a-fA-F]{6})", candidate)
    assert match is not None
    digits = match.group(1)
    if len(digits) == 3:
        digits = "".join(character * 2 for character in digits)
    red, green, blue = (int(digits[offset:offset + 2], 16) for offset in (0, 2, 4))
    return f"rgba({red}, {green}, {blue}, {alpha:g})"


def _control_color(style: Mapping[str, Any], document: Mapping[str, Any], name: str,
                   palette: Mapping[str, str], fallback: str) -> str:
    value = style.get(name)
    if not isinstance(value, str):
        return fallback
    value = value.strip()
    if value.startswith("hyprland."):
        value = _section(document, "hyprland").get(value.removeprefix("hyprland."))
        if not isinstance(value, str):
            return fallback
        value = value.strip()
    return palette.get(value.lower(), value) if _safe_css(value) else fallback


def _theme_css(colors: Mapping[str, Any], shell: Mapping[str, Any], rounding: str) -> str:
    values = dict(FALLBACK_THEME)
    palette = colors
    aliases = {
        "background": ("background", "bg"), "foreground": ("foreground", "fg"),
        "accent": ("accent", "primary"), "muted": ("muted", "inactive"),
        "selection": ("selection", "selected", "selection_background"),
        "mode": ("mode",),
    }
    for output, names in aliases.items():
        found = _first(palette, *names)
        if found is not None:
            values[output] = found
    named_colors = (
        "red", "yellow", "orange", "green", "cyan", "blue", "magenta", "brown",
        "bright_red", "bright_yellow", "bright_green", "bright_cyan", "bright_blue",
        "bright_magenta",
    )
    for name in named_colors:
        found = _first(palette, name)
        if found is not None:
            values[name] = found

    numbered = {
        0: _first(palette, "dark_background") or values["background"],
        1: values["red"], 2: values["green"], 3: values["yellow"],
        4: values["blue"], 5: values["magenta"], 6: values["cyan"],
        7: _first(palette, "light_foreground") or values["foreground"],
    }
    bright_numbered = {
        0: _first(palette, "lighter_background") or values["muted"],
        1: values["bright_red"], 2: values["bright_green"], 3: values["bright_yellow"],
        4: values["bright_blue"], 5: values["bright_magenta"], 6: values["bright_cyan"],
        7: _first(palette, "bright_foreground") or values["bright_color7"],
    }

    font = _section(shell, "font")
    spacing = _section(shell, "spacing")
    controls = _section(shell, "controls")
    base_size = max(1, math.floor(_number(font.get("base-size"), 12, minimum=1)))  # parseInt, as Style.qml reads it
    spacing_scale = _number(spacing.get("scale"), 1.0, minimum=0)
    scale_with_font = spacing.get("scale-with-font")
    if not isinstance(scale_with_font, bool):
        scale_with_font = True
    effective_scale = spacing_scale * (base_size / 12 if scale_with_font else 1)

    control_palette = {
        "background": values["background"], "foreground": values["foreground"],
        "accent": values["accent"], "text": values["foreground"],
    }
    normal_color = _control_color(controls, shell, "normal-color", control_palette, values["foreground"])
    hover_color = _control_color(controls, shell, "hover-cursor-color", control_palette, values["foreground"])
    focus_color = _control_color(controls, shell, "focus-border", control_palette, hover_color)
    normal_alpha = min(1, max(0, _number(controls.get("normal-fill-alpha"), 0.04)))
    border_alpha = min(1, max(0, _number(controls.get("normal-border-alpha"), 0.4)))
    hover_alpha = min(1, max(0, _number(controls.get("hover-cursor-fill-alpha"), 0.08)))
    focus_alpha = min(1, max(0, _number(controls.get("focus-border-alpha"), 0.25)))
    border_color = _control_color(controls, shell, "normal-border", control_palette, normal_color)

    lines = [":root {"]
    for name in ("background", "foreground", "accent", "muted", "selection", "mode"):
        lines.append(f"  --{_css_name(name)}: {values[name]};")
    for name in named_colors:
        lines.append(f"  --{_css_name(name)}: {values[name]};")
    for number in range(8):
        lines.append(f"  --color-{number}: {numbered[number]};")
        lines.append(f"  --bright-color-{number}: {bright_numbered[number]};")
    lines.extend([
        f"  --font-size: {base_size}px;",
        f"  --font-size-small: {_rounded(base_size * 0.917)}px;",
        f"  --font-size-large: {_rounded(base_size * 1.333)}px;",
        f"  --spacing: {_spacing_token(spacing, 'control-gap', 8, effective_scale)}px;",
        f"  --spacing-small: {_spacing_token(spacing, 'sm', 4, effective_scale)}px;",
        f"  --spacing-large: {_spacing_token(spacing, 'huge', 18, effective_scale)}px;",
        f"  --control-height: {_spacing_token(spacing, 'control-height', 28, effective_scale)}px;",
        f"  --control-padding-x: {_spacing_token(spacing, 'control-padding-x', 10, effective_scale)}px;",
        f"  --control-padding-y: {_spacing_token(spacing, 'control-padding-y', 6, effective_scale)}px;",
        f"  --control-fill: {_rgba(normal_color, normal_alpha, values['foreground'])};",
        f"  --control-border: {_rgba(border_color, border_alpha, values['foreground'])};",
        f"  --control-fill-hover: {_rgba(hover_color, hover_alpha, values['foreground'])};",
        f"  --control-border-focus: {_rgba(focus_color, focus_alpha, values['foreground'])};",
        f"  --control-radius: {rounding};", "  --font-monospace: monospace;",
    ])
    lines.append("}")
    return "\n".join(lines) + "\n"


class AtlasState:
    """Shared mutable state; request handlers never hold its lock while writing."""

    def __init__(self, *, config_path: str | Path | None, cache_path: str | Path | None,
                 reader_dir: str | Path | None, theme_dir: str | Path | None,
                 shell_override_path: str | Path | None,
                 editor_launcher: str | Sequence[str], interval: float = INDEX_INTERVAL,
                 rounding_command: str | Sequence[str] | None = ("hyprctl", "-j", "getoption", "decoration:rounding")):
        self.store = atlas_index.IndexStore(config_path, cache_path)
        self.reader_dir = Path(reader_dir) if reader_dir is not None else APP_ROOT / "reader"
        home = Path(os.environ.get("HOME", str(Path.home())))
        self.theme_dir = Path(theme_dir) if theme_dir is not None else home / ".local/state/omarchy/current/theme"
        self.shell_override_path = (Path(shell_override_path) if shell_override_path is not None
                                    else home / ".config/omarchy/shell.toml")
        self.editor_launcher = editor_launcher
        self.interval = interval
        self.rounding_command = rounding_command
        self.lock = threading.RLock()
        self.index: dict[str, Any] | None = None
        self.last_index_attempt = 0.0
        self.index_error: str | None = None
        self.fingerprints: dict[tuple[str, str], str] = {}
        self.theme = _theme_css({}, {}, "0px")
        self.theme_error: str | None = None
        self.last_theme_attempt = 0.0
        self.clients: set[queue.Queue[tuple[str, Any, queue.Queue[bool] | None]]] = set()

    def _broadcast(self, event: str, data: Any) -> None:
        with self.lock:
            clients = list(self.clients)
        for client in clients:
            try:
                client.put_nowait((event, data, None))
            except queue.Full:
                # A client that cannot consume a small event backlog must not
                # delay all the other readers.
                self.remove_client(client)

    def deliver_show(self, data: Any) -> int:
        """Return only clients that wrote and flushed this show event."""
        with self.lock:
            clients = list(self.clients)
        pending: list[tuple[queue.Queue[tuple[str, Any, queue.Queue[bool] | None]], queue.Queue[bool]]] = []
        for client in clients:
            delivered: queue.Queue[bool] = queue.Queue(maxsize=1)
            try:
                client.put_nowait(("show", data, delivered))
                pending.append((client, delivered))
            except queue.Full:
                self.remove_client(client)

        deadline = time.monotonic() + DELIVERY_TIMEOUT
        successful = 0
        for client, delivered in pending:
            try:
                if delivered.get(timeout=max(0.0, deadline - time.monotonic())):
                    successful += 1
                else:
                    self.remove_client(client)
            except queue.Empty:
                self.remove_client(client)
        return successful

    def add_client(self) -> queue.Queue[tuple[str, Any, queue.Queue[bool] | None]]:
        client: queue.Queue[tuple[str, Any, queue.Queue[bool] | None]] = queue.Queue(maxsize=32)
        with self.lock:
            self.clients.add(client)
        return client

    def remove_client(self, client: queue.Queue[tuple[str, Any, queue.Queue[bool] | None]]) -> None:
        with self.lock:
            self.clients.discard(client)

    def client_count(self) -> int:
        with self.lock:
            return len(self.clients)

    def _fingerprint_index(self, index: Mapping[str, Any]) -> dict[tuple[str, str], str]:
        roots = {item["name"]: Path(item["path"]) for item in index["roots"]}
        result: dict[tuple[str, str], str] = {}
        for item in index["files"]:
            root = roots.get(item["root"])
            if root is None:
                continue
            candidate = root / item["path"]
            try:
                if not _inside(candidate, root):
                    continue
                # Above the cap a file is never read: its size and mtime stand for its content.
                with candidate.open("rb") as handle:
                    status = os.fstat(handle.fileno())
                    data = handle.read(MAX_FILE_BYTES + 1) if status.st_size <= MAX_FILE_BYTES else b""
                if status.st_size > MAX_FILE_BYTES or len(data) > MAX_FILE_BYTES:
                    result[(item["root"], item["path"])] = f"{status.st_size}:{status.st_mtime_ns}"
                else:
                    result[(item["root"], item["path"])] = hashlib.sha256(data).hexdigest()
            except OSError:
                # A race with an editor deletion is represented by omission.
                pass
        return result

    def refresh_index(self, *, force: bool = False) -> dict[str, Any] | None:
        now = time.monotonic()
        with self.lock:
            if not force and self.index is not None and now - self.last_index_attempt < self.interval:
                return self.index
            self.last_index_attempt = now
            old = self.index
            old_fingerprints = self.fingerprints
            try:
                candidate = self.store.rebuild()
                fingerprints = self._fingerprint_index(candidate)
            except (atlas_index.IndexError, OSError) as exc:
                self.index_error = str(exc)
                return old
            self.index = candidate
            self.fingerprints = fingerprints
            self.index_error = None
        if old is not None and atlas_index.semantic_index(old) != atlas_index.semantic_index(candidate):
            self._broadcast("index", {})
        if old is not None:
            changed = sorted(set(old_fingerprints) | set(fingerprints))
            for root, path in changed:
                if old_fingerprints.get((root, path)) != fingerprints.get((root, path)):
                    self._broadcast("file", {"root": root, "path": path})
        return candidate

    def get_index(self) -> dict[str, Any]:
        index = self.refresh_index()
        if index is None:
            raise ServeError(HTTPStatus.SERVICE_UNAVAILABLE, self.index_error or "index unavailable")
        return index

    def _rounding(self) -> str:
        if self.rounding_command is None:
            return "0px"
        try:
            result = subprocess.run(_command(self.rounding_command), check=False, capture_output=True,
                                    timeout=STYLE_TIMEOUT)
            if result.returncode:
                return "0px"
            value = json.loads(result.stdout.decode("utf-8"))
            number = value.get("int", value.get("value", 0)) if isinstance(value, Mapping) else 0
            if isinstance(number, (int, float)) and number >= 0:
                return f"{number}px"
        except (OSError, subprocess.TimeoutExpired, UnicodeDecodeError, json.JSONDecodeError):
            pass
        return "0px"

    def refresh_theme(self, *, force: bool = False) -> str:
        now = time.monotonic()
        with self.lock:
            if not force and now - self.last_theme_attempt < self.interval:
                return self.theme
            self.last_theme_attempt = now
            old = self.theme
            try:
                colors_path = self.theme_dir / "colors.toml"
                shell_path = self.theme_dir / "shell.toml"
                colors = _read_toml(colors_path) if colors_path.exists() else {}
                shell = _read_toml(shell_path) if shell_path.exists() else {}
                if self.shell_override_path.exists():
                    shell = _merge_toml(shell, _read_toml(self.shell_override_path))
                candidate = _theme_css(colors, shell, self._rounding())
            except (OSError, ValueError, TypeError) as exc:
                self.theme_error = str(exc)
                return old
            self.theme = candidate
            self.theme_error = None
        if candidate != old:
            self._broadcast("theme", {})
        return candidate

    def root_path(self, root_name: str) -> Path:
        for item in self.get_index()["roots"]:
            if item["name"] == root_name:
                return Path(item["path"])
        raise ServeError(HTTPStatus.FORBIDDEN, "path is outside registered roots")

    def contained_file(self, root_name: str, relative: str) -> Path:
        root = self.root_path(root_name)
        safe_relative = _safe_relative(relative)
        if atlas_index.denied_path(safe_relative.as_posix()):
            raise ServeError(HTTPStatus.FORBIDDEN, "file is denied by the credential policy", "denied")
        candidate = root / safe_relative
        try:
            target = candidate.resolve(strict=False).relative_to(root.resolve(strict=True))
        except (OSError, ValueError):
            raise ServeError(HTTPStatus.FORBIDDEN, "path is outside registered roots")
        # A symlink such as leak.md -> .env is judged by the file it opens.
        if atlas_index.denied_path(target.as_posix()):
            raise ServeError(HTTPStatus.FORBIDDEN, "file is denied by the credential policy", "denied")
        if not candidate.is_file():
            raise ServeError(HTTPStatus.NOT_FOUND, "file not found", "not_found")
        return candidate

    def indexed_file(self, root_name: str, relative: str) -> tuple[dict[str, Any], Path]:
        candidate = self.contained_file(root_name, relative)
        index = self.get_index()
        for item in index["files"]:
            if item["root"] != root_name:
                continue
            root = self.root_path(root_name)
            known = root / item["path"]
            if candidate == known or (candidate.exists() and known.exists() and candidate.resolve() == known.resolve()):
                return item, candidate
        raise ServeError(HTTPStatus.NOT_FOUND, "document is not indexed")


class AtlasHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], state: AtlasState):
        self.state = state
        super().__init__(address, AtlasRequestHandler)


def _read_capped(path: Path) -> bytes:
    """Refuse an oversized file from its size, before reading any of it."""
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ServeError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "file exceeds 2 MB")
    return path.read_bytes()


class AtlasRequestHandler(BaseHTTPRequestHandler):
    server: AtlasHTTPServer
    protocol_version = "HTTP/1.1"
    timeout = REQUEST_TIMEOUT
    policy = PAGE_POLICY

    def log_message(self, _format: str, *_args: Any) -> None:
        # Service.qml owns diagnostics; routine browser requests are not logs.
        return

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", self.policy)
        super().end_headers()

    def _check_origin(self, *, post: bool) -> None:
        """Answer only Atlas's own origin: no DNS rebinding, no cross-site POST."""
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if self.headers.get("Host") not in hosts:
            raise ServeError(HTTPStatus.FORBIDDEN, "request host is not Atlas")
        if not post:
            return
        # application/json is not a CORS simple type, so a cross-site page
        # needs a preflight that this server never answers.
        if self.headers.get_content_type() != "application/json":
            raise ServeError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "body must be application/json")
        origin = self.headers.get("Origin")
        if origin is not None and origin not in {"http://" + host for host in hosts}:
            raise ServeError(HTTPStatus.FORBIDDEN, "cross-site request refused")
        if self.headers.get("Sec-Fetch-Site", "same-origin") != "same-origin":
            raise ServeError(HTTPStatus.FORBIDDEN, "cross-site request refused")

    def _send(self, status: int, body: bytes = b"", content_type: str = "text/plain; charset=utf-8",
              *, etag: str | None = None) -> None:
        if etag is not None and self.headers.get("If-None-Match") == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if etag is not None:
            self.send_header("ETag", etag)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, value: Any, status: int = HTTPStatus.OK, *, etag: str | None = None) -> None:
        self._send(status, (json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8"),
                   "application/json; charset=utf-8", etag=etag)

    def _error(self, error: ServeError) -> None:
        body = {"error": error.message}
        if error.code is not None:
            body["code"] = error.code
        self._json(body, error.status)

    def _static(self, relative: str) -> None:
        candidate = self.server.state.reader_dir / _safe_relative(relative)
        try:
            resolved = candidate.resolve(strict=True)
            reader = self.server.state.reader_dir.resolve(strict=True)
            resolved.relative_to(reader)
            if not resolved.is_file():
                raise FileNotFoundError
            data = resolved.read_bytes()
        except (OSError, ValueError):
            raise ServeError(HTTPStatus.NOT_FOUND, "asset not found")
        self._send(HTTPStatus.OK, data, STATIC_TYPES.get(resolved.suffix.lower(), "application/octet-stream"))

    def _app(self) -> None:
        self._static("index.html")

    def _route_target(self, parts: list[str], start: int) -> None:
        if len(parts) <= start:
            raise ServeError(HTTPStatus.NOT_FOUND, "route not found")
        root = parts[start]
        relative = "/".join(parts[start + 1:])
        self.server.state.indexed_file(root, relative)

    def do_GET(self) -> None:
        self.policy = PAGE_POLICY
        try:
            self._check_origin(post=False)
            split = urlsplit(self.path)
            parts = _safe_url_parts(split.path)
            route = "/" + "/".join(parts)
            if route == "/":
                self._app()
            elif parts and parts[0] == "read":
                self._route_target(parts, 1)
                self._app()
            elif route == "/map":
                self._app()
            elif parts and parts[0] == "map":
                self._route_target(parts, 1)
                self._app()
            elif route in {"/app.js", "/app.css", "/map.js", "/map.css"}:
                self._static(route.lstrip("/"))
            elif parts and parts[0] == "vendor" and len(parts) == 2:
                self._static("vendor/" + parts[1])
            elif route == "/theme.css":
                css = self.server.state.refresh_theme().encode("utf-8")
                self._send(HTTPStatus.OK, css, "text/css; charset=utf-8")
            elif route == "/api/index":
                self._json(self.server.state.get_index())
            elif route == "/api/file":
                query = parse_qs(split.query, keep_blank_values=True, errors="surrogateescape")
                root = query.get("root", [""])[0]
                relative = query.get("path", [""])[0]
                item, candidate = self.server.state.indexed_file(root, relative)
                data = _read_capped(candidate)
                index = self.server.state.get_index()
                identity = {"root": item["root"], "path": item["path"]}
                cost = []
                if item["kind"] == "instruction":
                    try:
                        cost = [row for row in atlas_analyze.cost(index)["roots"]
                                if row["root"] == item["root"]
                                and any(file["path"] == item["path"] for file in row["startup"])]
                    except (atlas_index.IndexError, OSError):
                        # Another root's cost input is gone or unreadable; the
                        # document itself still loads, with no cost rows.
                        cost = []
                result = {"file": item, "cost": cost,
                          "references": {"inbound": [ref for ref in index["references"] if ref["to"] == identity],
                                         "outbound": [ref for ref in index["references"] if ref["from"] == identity]}}
                try:
                    result["content"] = data.decode("utf-8")
                except UnicodeDecodeError:
                    result.update({"binary": True, "bytes": len(data)})
                representation = (json.dumps(result, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
                self._json(result, etag=_etag(representation))
            elif parts and parts[0] == "raw" and len(parts) >= 3:
                root = parts[1]
                relative = "/".join(parts[2:])
                self.policy = RAW_POLICY
                candidate = self.server.state.contained_file(root, relative)
                # Judged by the file it opens: logo.png -> config.yaml is YAML.
                suffix = candidate.resolve().suffix.lower()
                content_type = RAW_TYPES.get(suffix)
                if content_type is None:
                    raise ServeError(HTTPStatus.NOT_FOUND, "unsupported raw file type")
                if suffix not in IMAGE_TYPES:
                    # Beyond images, /raw serves only what the index already shows.
                    self.server.state.indexed_file(root, relative)
                data = _read_capped(candidate)
                self._send(HTTPStatus.OK, data, content_type, etag=_etag(data))
            elif route == "/api/events":
                self._events()
            else:
                raise ServeError(HTTPStatus.NOT_FOUND, "route not found")
        except ServeError as error:
            self._error(error)
        except (BrokenPipeError, ConnectionResetError):
            return
        except OSError as error:
            self._error(ServeError(HTTPStatus.NOT_FOUND, str(error)))

    def _body_json(self) -> Mapping[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 1024 * 1024:
                raise ValueError
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            raise ServeError(HTTPStatus.BAD_REQUEST, "body must be a JSON object") from None
        if not isinstance(value, Mapping):
            raise ServeError(HTTPStatus.BAD_REQUEST, "body must be a JSON object")
        return value

    def do_POST(self) -> None:
        self.policy = PAGE_POLICY
        try:
            self._check_origin(post=True)
            route = "/" + "/".join(_safe_url_parts(urlsplit(self.path).path))
            if route not in {"/api/show", "/api/edit"}:
                raise ServeError(HTTPStatus.NOT_FOUND, "route not found")
            body = self._body_json()
            root, relative = body.get("root"), body.get("path")
            if not isinstance(root, str) or not isinstance(relative, str):
                raise ServeError(HTTPStatus.BAD_REQUEST, "root and path are required")
            item, candidate = self.server.state.indexed_file(root, relative)
            canonical = item["path"]
            if route == "/api/show":
                view = body.get("view")
                if view not in {"read", "map"}:
                    raise ServeError(HTTPStatus.BAD_REQUEST, "view must be read or map")
                clients = self.server.state.deliver_show(
                    {"root": root, "path": canonical, "view": view}
                )
                self._json({"clients": clients})
            else:
                launch_editor(candidate.resolve(), self.server.state.editor_launcher)
                self._json({"opened": True})
        except ServeError as error:
            # A refused request may leave its body unread on the socket.
            self.close_connection = True
            self._error(error)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _events(self) -> None:
        client = self.server.state.add_client()
        delivered: queue.Queue[bool] | None = None
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            self.wfile.flush()
            next_refresh = time.monotonic()
            while True:
                # An SSE connection is the server's refresh clock.  The queue
                # wait is short enough to deliver events promptly.  Each
                # refresh tick writes a comment so closed idle sockets are
                # detected without changing any application event.
                now = time.monotonic()
                if now >= next_refresh:
                    self.server.state.refresh_index()
                    self.server.state.refresh_theme()
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    next_refresh = now + self.server.state.interval
                try:
                    timeout = min(0.25, max(0.0, next_refresh - time.monotonic()))
                    event, data, delivered = client.get(timeout=timeout)
                except queue.Empty:
                    continue
                payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=True, separators=(',', ':'))}\n\n"
                self.wfile.write(payload.encode("utf-8"))
                self.wfile.flush()
                if delivered is not None:
                    delivered.put_nowait(True)
                    delivered = None
        except OSError:
            if delivered is not None:
                delivered.put_nowait(False)
            return
        finally:
            self.server.state.remove_client(client)


def create_server(*, port: int = 4137, config_path: str | Path | None = None,
                  cache_path: str | Path | None = None, reader_dir: str | Path | None = None,
                  theme_dir: str | Path | None = None, shell_override_path: str | Path | None = None,
                  editor_launcher: str | Sequence[str] = "omarchy-launch-editor",
                  refresh_interval: float = INDEX_INTERVAL,
                  rounding_command: str | Sequence[str] | None = ("hyprctl", "-j", "getoption", "decoration:rounding")) -> AtlasHTTPServer:
    """Build, but do not start, an Atlas server bound only to IPv4 loopback."""
    state = AtlasState(config_path=config_path, cache_path=cache_path, reader_dir=reader_dir,
                       theme_dir=theme_dir, shell_override_path=shell_override_path,
                       editor_launcher=editor_launcher,
                       interval=refresh_interval, rounding_command=rounding_command)
    return AtlasHTTPServer(("127.0.0.1", port), state)


def serve(*, port: int = 4137) -> None:
    """Run the foreground service used by the QML supervisor."""
    with create_server(port=port) as server:
        server.serve_forever(poll_interval=0.5)
