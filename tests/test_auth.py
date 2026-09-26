"""Owner-only state behavior under permissive modes and concurrent creation."""

from __future__ import annotations

import os
from pathlib import Path
import stat
import tempfile
import threading
import unittest

import atlas_auth
import atlas_index


class PrivateStateTests(unittest.TestCase):
    def test_fresh_state_ignores_permissive_umask(self) -> None:
        for mask in (0o022, 0o002):
            with self.subTest(mask=oct(mask)), tempfile.TemporaryDirectory() as temporary:
                owned = Path(temporary) / "omarchy-atlas"
                previous = os.umask(mask)
                try:
                    atlas_index.write_config({"version": 1, "roots": []}, owned / "config.json")
                    atlas_auth.server_secret(owned / "server-secret", create=True)
                finally:
                    os.umask(previous)
                self.assertEqual(stat.S_IMODE(owned.stat().st_mode), 0o700)
                for name in ("config.json", "server-secret"):
                    self.assertEqual(stat.S_IMODE((owned / name).stat().st_mode), 0o600)

    def test_modes_are_narrowed_without_touching_xdg_parents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            parent = base / "xdg"
            parent.mkdir(mode=0o755)
            owned = parent / "omarchy-atlas"
            owned.mkdir(mode=0o777)
            owned.chmod(0o777)
            config = owned / "config.json"
            config.write_text('{"version":1,"roots":[]}', encoding="utf-8")
            config.chmod(0o666)
            self.assertEqual(atlas_index.read_config(config)["roots"], [])
            self.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE(owned.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
            secret = atlas_auth.server_secret(owned / "server-secret", create=True)
            self.assertEqual(len(secret), 32)
            self.assertEqual(stat.S_IMODE((owned / "server-secret").stat().st_mode), 0o600)

    def test_symlinked_state_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            outside = base / "outside"
            outside.write_text("untouched", encoding="utf-8")
            owned = base / "omarchy-atlas"
            owned.mkdir()
            (owned / "config.json").symlink_to(outside)
            with self.assertRaises(atlas_index.IndexError):
                atlas_index.read_config(owned / "config.json")
            (owned / "server-secret").symlink_to(outside)
            with self.assertRaises(atlas_index.IndexError):
                atlas_auth.server_secret(owned / "server-secret", create=True)
            link = base / "linked-atlas"
            link.symlink_to(owned, target_is_directory=True)
            with self.assertRaises(atlas_index.IndexError):
                atlas_index.private_directory(link)
            self.assertEqual(outside.read_text(encoding="utf-8"), "untouched")

    def test_concurrent_secret_creation_uses_one_value(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "omarchy-atlas/server-secret"
            values: list[bytes] = []
            failures: list[Exception] = []
            def read() -> None:
                try:
                    values.append(atlas_auth.server_secret(path, create=True))
                except Exception as exc:
                    failures.append(exc)
            threads = [threading.Thread(target=read) for _ in range(12)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertFalse(failures)
            self.assertEqual(len(values), 12)
            self.assertEqual(len(set(values)), 1)
