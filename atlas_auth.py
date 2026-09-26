"""Owner-only local credentials and one-use browser bootstrap."""

from __future__ import annotations

import hashlib
import hmac
import html
import os
from pathlib import Path
import secrets
import stat
import time

import atlas_index

SECRET_NAME = "server-secret"
BOOTSTRAP_LIFETIME = 30


def browser_token(secret: bytes, port: int) -> str:
    """A browser credential valid only at this loopback port, across restarts."""
    return hmac.new(secret, f"atlas-browser\n127.0.0.1:{port}".encode(), hashlib.sha256).hexdigest()


def secret_path(config_path: Path | None = None) -> Path:
    return (config_path or atlas_index.state_paths()[0]).parent / SECRET_NAME


def server_secret(path: Path, *, create: bool = False) -> bytes:
    atlas_index.private_directory(path.parent)
    if create:
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "wb") as target:
                target.write(secrets.token_bytes(32).hex().encode("ascii"))
    if not atlas_index.private_file(path):
        raise atlas_index.IndexError("server_unavailable", "server credential is unavailable")
    for attempt in range(20):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise atlas_index.IndexError("config_invalid", "server credential has unsafe owner or type")
            value = os.read(fd, 65)
        finally:
            os.close(fd)
        if len(value) == 64 or not create:
            break
        time.sleep(0.01)
    if len(value) != 64:
        raise atlas_index.IndexError("config_invalid", "server credential is invalid")
    try:
        return bytes.fromhex(value.decode("ascii"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise atlas_index.IndexError("config_invalid", "server credential is invalid") from exc


def signature(secret: bytes, nonce: str, expires: int, target: str) -> str:
    value = f"{nonce}\n{expires}\n{target}".encode("utf-8")
    return hmac.new(secret, value, hashlib.sha256).hexdigest()


def bootstrap_file(cache_path: Path, secret: bytes, target: str, origin: str) -> Path:
    atlas_index.private_directory(cache_path.parent)
    nonce = secrets.token_hex(24)
    expires = int(time.time()) + BOOTSTRAP_LIFETIME
    fields = {"nonce": nonce, "expires": str(expires), "target": target,
              "signature": signature(secret, nonce, expires, target)}
    inputs = "".join(f'<input type="hidden" name="{key}" value="{html.escape(value, quote=True)}">'
                     for key, value in fields.items())
    page = ('<!doctype html><meta charset="utf-8"><title>Markdown Atlas Reader</title>'
            '<form id="open" method="post" action="' + html.escape(origin, quote=True)
            + '/auth/bootstrap">' + inputs + '</form><script>document.getElementById("open").submit()</script>')
    path = cache_path.parent / f"bootstrap-{nonce}.html"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write(page)
    return path
