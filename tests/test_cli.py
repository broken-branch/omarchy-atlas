"""CLI contract tests run the real entry point as a subprocess."""

from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
import resource
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import atlas_index
import atlas_auth
import atlas_serve


PROJECT = Path(__file__).resolve().parents[1]
ATLAS = PROJECT / "atlas.py"
WRAPPER = PROJECT / "bin" / "atlas"
FIXTURE = Path(__file__).parent / "fixtures" / "cli"
INDEX_FIXTURE = Path(__file__).parent / "fixtures" / "index" / "plain"
SERVE_READER = Path(__file__).parent / "fixtures" / "serve" / "reader"


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.home = self.base / "home"
        self.config_home = self.base / "config"
        self.cache_home = self.base / "cache"
        self.root = self.base / "root with spaces Ω"
        shutil.copytree(FIXTURE / "root with spaces", self.root)
        self.launchers = self.base / "launchers"
        self.launchers.mkdir()
        self.argv_log = self.base / "argv.jsonl"
        for name in ("omarchy-launch-editor", "omarchy-launch-or-focus-webapp"):
            target = self.launchers / name
            shutil.copyfile(FIXTURE / "record_argv.py", target)
            target.chmod(0o755)
        closed_socket = socket.socket()
        closed_socket.bind(("127.0.0.1", 0))
        self.addCleanup(closed_socket.close)
        self.env = os.environ.copy()
        self.env.update({
            "HOME": str(self.home),
            "XDG_CONFIG_HOME": str(self.config_home),
            "XDG_CACHE_HOME": str(self.cache_home),
            "PATH": str(self.launchers) + os.pathsep + self.env.get("PATH", ""),
            "ATLAS_ARGV_LOG": str(self.argv_log),
            "PYTHONDONTWRITEBYTECODE": "1",
            # A closed port: the desktop runner has the installed Markdown Atlas server on 4137.
            "ATLAS_SERVER_URL": f"http://127.0.0.1:{closed_socket.getsockname()[1]}",
        })

    def _test_credential(self) -> None:
        credential = atlas_auth.server_secret(atlas_auth.secret_path(self.config_home / "omarchy-atlas/config.json"), create=True)
        self.env["ATLAS_TEST_SERVER_SECRET"] = credential.hex()

    def run_cli(self, *arguments: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, "-B", str(ATLAS), *arguments], cwd=PROJECT,
                              env=env or self.env, text=True, capture_output=True, check=False, timeout=10)

    def reply(self, *arguments: str, env: dict[str, str] | None = None) -> tuple[subprocess.CompletedProcess[str], dict]:
        result = self.run_cli(*arguments, "--json", env=env)
        self.assertEqual(result.stdout.count("\n"), 1, result)
        return result, json.loads(result.stdout)

    def add_root(self, name: str = "Demo Ω") -> None:
        result, reply = self.reply("root-add", str(self.root), "--name", name)
        self.assertEqual((result.returncode, result.stderr, reply["ok"]), (0, "", True))

    @staticmethod
    def fresh(cache: Path) -> None:
        """Date the saved index a minute ahead, so that no test depends on running within 2 s."""
        ahead = time.time() + 60
        os.utime(cache, (ahead, ahead))

    def launcher_rows(self) -> list[list[str]]:
        return [json.loads(line) for line in self.argv_log.read_text(encoding="utf-8").splitlines()]

    def git(self, root: Path, *arguments: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(["git", "-C", str(root), "-c", "user.name=Atlas",
                               "-c", "user.email=atlas@example.test", *arguments],
                              env=self.env, capture_output=True, check=check, timeout=10)

    def committed(self, root: Path) -> None:
        self.git(root, "init")
        self.git(root, "add", ".")
        self.git(root, "commit", "-m", "fixture")

    def test_files_reply_exposes_modified_and_open(self) -> None:
        self.home.mkdir()
        self.committed(self.root)
        target = self.root / "README.md"
        os.utime(target, ns=(1_700_000_123_456_789_000, 1_700_000_123_456_789_000))
        swap_dir = self.home / ".local/state/nvim/swap"
        swap_dir.mkdir(parents=True)
        (swap_dir / f"{str(target).replace('/', '%')}.swp").touch()

        result, reply = self.reply("files", "--path", str(self.root))

        self.assertEqual((result.returncode, reply["ok"]), (0, True))
        files = {item["path"]: item for item in reply["data"]["files"]}
        self.assertEqual((files["README.md"]["timeSource"], files["README.md"]["modified"], files["README.md"]["open"]),
                         ("git", "2023-11-14T22:15:23.456789000Z", True))
        self.assertNotEqual(files["README.md"]["time"], files["README.md"]["modified"])
        self.assertFalse(files["docs/guide.md"]["open"])

    def test_650_documents_with_path_tokens_finish_within_budget(self) -> None:
        crowded = self.root / "crowded"
        crowded.mkdir()
        (crowded / "target.md").write_text("# Target\n", encoding="utf-8")
        for number in range(650):
            (crowded / f"source-{number:04}.md").write_text(
                "target.md target.md target.md target.md\n", encoding="utf-8")

        started = time.monotonic()
        result, reply = self.reply("orphans", "--path", str(self.root))
        elapsed = time.monotonic() - started

        self.assertLess(elapsed, 3)
        self.assertEqual((result.returncode, reply["ok"], result.stderr), (0, True, ""))
        self.assertNotIn("crowded/target.md", {item["path"] for item in reply["data"]["orphans"]})

    def test_hostile_lines_finish_within_budget(self) -> None:
        (self.root / "README.md").write_text("# a" + " " * 3000 + "x\n", encoding="utf-8")
        (self.root / "docs" / "brackets.md").write_text(
            "[[" * 20000 + "\n" + "[" * 200000 + "\n" + "[a](" * 50000 + "\n", encoding="utf-8")

        started = time.monotonic()
        result, reply = self.reply("files", "--path", str(self.root))
        elapsed = time.monotonic() - started

        self.assertLess(elapsed, 1)
        self.assertEqual((result.returncode, reply["ok"]), (0, True))
        titles = {item["path"]: item["title"] for item in reply["data"]["files"]}
        self.assertEqual(titles["README.md"], "a" + " " * 3000 + "x")

    def test_20000_links_finish_within_budget(self) -> None:
        (self.root / "docs" / "links.md").write_text("[a](guide.md) " * 20000 + "\n", encoding="utf-8")

        started = time.monotonic()
        result, reply = self.reply("files", "--path", str(self.root))
        elapsed = time.monotonic() - started

        self.assertLess(elapsed, 3)
        self.assertEqual((result.returncode, reply["ok"]), (0, True))

    def test_unmatched_backtick_runs_finish_within_budget(self) -> None:
        # 600 openers of distinct lengths that never close, then 150,000 closed spans.
        (self.root / "docs" / "backticks.md").write_text(
            " ".join("`" * length for length in range(2, 602)) + " " + "` " * 150000 + "\n",
            encoding="utf-8")

        started = time.monotonic()
        result, reply = self.reply("files", "--path", str(self.root))
        elapsed = time.monotonic() - started

        self.assertLess(elapsed, 3)
        self.assertEqual((result.returncode, reply["ok"]), (0, True))

    def test_heading_title_keeps_a_hash_that_is_not_a_closing_sequence(self) -> None:
        (self.root / "docs" / "guide.md").write_text("  # Notes on C#  \n", encoding="utf-8")
        (self.root / "docs" / "orphan.md").write_text("#nospace\n# Closed ##\n", encoding="utf-8")

        _result, reply = self.reply("files", "--path", str(self.root))

        # Stripping a closing "#" run that does not follow a space titles guide.md "Notes on C".
        titles = {item["path"]: item["title"] for item in reply["data"]["files"]}
        self.assertEqual((titles["docs/guide.md"], titles["docs/orphan.md"]), ("Notes on C#", "Closed"))

    def test_nested_repository_fsmonitor_does_not_run_while_indexing(self) -> None:
        vendored = self.root / "vendored"
        vendored.mkdir()
        (vendored / "notes.md").write_text("# Notes\n", encoding="utf-8")
        self.committed(vendored)
        marker = self.base / "PWNED-fsmonitor"
        with (vendored / ".git" / "config").open("a", encoding="utf-8") as config:
            config.write(f'[core]\n\tfsmonitor = "touch {marker}; echo"\n')
        self.git(vendored, "ls-files")
        self.assertTrue(marker.exists(), "the fixture must run fsmonitor for plain git")
        marker.unlink()

        result, reply = self.reply("files", "--path", str(self.root))

        # Removing -c core.fsmonitor=false from _git runs the command again.
        self.assertEqual((result.returncode, reply["ok"]), (0, True))
        self.assertIn("vendored/notes.md", [item["path"] for item in reply["data"]["files"]])
        self.assertFalse(marker.exists())

    def test_signature_program_does_not_run_while_reading_git_times(self) -> None:
        self.committed(self.root)
        commit = self.git(self.root, "cat-file", "commit", "HEAD").stdout.decode("utf-8")
        header, _separator, message = commit.partition("\n\n")
        signed = (header + "\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n"
                  " -----END PGP SIGNATURE-----\n\n" + message)
        written = subprocess.run(["git", "-C", str(self.root), "hash-object", "-t", "commit", "-w", "--stdin"],
                                 input=signed.encode("utf-8"), env=self.env, capture_output=True,
                                 check=True, timeout=10)
        self.git(self.root, "update-ref", "HEAD", written.stdout.decode("ascii").strip())
        marker = self.base / "PWNED-gpg"
        program = self.base / "fake-gpg"
        program.write_text(f"#!/bin/sh\ntouch '{marker}'\n", encoding="utf-8")
        program.chmod(0o755)
        self.git(self.root, "config", "log.showSignature", "true")
        self.git(self.root, "config", "gpg.program", str(program))
        self.git(self.root, "log", "-1", "--format=%ct", "--", "README.md")
        self.assertTrue(marker.exists(), "the fixture must run gpg.program for plain git log")
        marker.unlink()

        result, reply = self.reply("files", "--path", str(self.root))

        # Removing both log.showSignature=false and --no-show-signature runs the program again.
        self.assertEqual((result.returncode, reply["ok"]), (0, True))
        self.assertEqual({item["timeSource"] for item in reply["data"]["files"]}, {"git"})
        self.assertFalse(marker.exists())

    def test_tracked_directory_replaced_by_symlink_out_of_root_is_not_indexed(self) -> None:
        (self.root / "tracked").mkdir()
        (self.root / "tracked" / "t.md").write_text("# t-inside\n", encoding="utf-8")
        self.committed(self.root)
        outside = self.base / "outside" / "docs"
        outside.mkdir(parents=True)
        (outside / "t.md").write_text("# t-outside\n", encoding="utf-8")
        shutil.rmtree(self.root / "tracked")
        (self.root / "tracked").symlink_to(outside)

        _result, reply = self.reply("files", "--path", str(self.root))

        # Accepting S_ISREG without the parent's _inside check lists tracked/t.md, titled t-outside.
        self.assertEqual([item["path"] for item in reply["data"]["files"]],
                         ["AGENTS.md", "README.md", "docs/guide.md", "docs/orphan.md"])

    def test_symlink_to_a_credential_file_is_not_indexed_or_read(self) -> None:
        (self.root / ".env").write_text("SECRET_TOKEN=abc123\n", encoding="utf-8")
        (self.root / "leak.md").symlink_to(".env")
        (self.root / "notes.txt").symlink_to(".env")
        self.add_root()

        _result, indexed = self.reply("files", "--root", "Demo Ω")
        results = [self.reply("file", "--root", "Demo Ω", "--path", name) for name in ("leak.md", "notes.txt")]

        # Checking denied_path on the listed name only indexes leak.md and returns the secret.
        self.assertNotIn("leak.md", [item["path"] for item in indexed["data"]["files"]])
        # Checking only the requested name in _indexed_file answers not_found instead.
        self.assertEqual([(result.returncode, reply["code"]) for result, reply in results],
                         [(0, "denied"), (0, "denied")])

    def test_document_above_the_size_cap_is_a_fact_without_content(self) -> None:
        big = self.root / "docs" / "big.md"
        line = "[Missing](missing.md)\n"
        big.write_text("# Big\n" + line * (atlas_index.MAX_FILE_BYTES // len(line) + 1), encoding="utf-8")
        (self.root / "docs" / "small.md").write_text("# Small\n[big](big.md)\n", encoding="utf-8")

        _result, files = self.reply("files", "--path", str(self.root))
        _result, dangling = self.reply("dangling", "--path", str(self.root))

        # Reading the file in full gives it the title Big, its lines and ~95,000 dangling rows.
        fact = next(item for item in files["data"]["files"] if item["path"] == "docs/big.md")
        self.assertEqual((fact["title"], fact["bytes"], fact["lines"], fact["outbound"], fact["inbound"]),
                         ("big.md", big.stat().st_size, 0, 0, 1))
        self.assertEqual([item["from"]["path"] for item in dangling["data"]["dangling"]], ["docs/guide.md"])

    def test_file_command_refuses_an_oversized_file_from_its_size(self) -> None:
        self.add_root()
        huge = self.root / "docs" / "huge.md"
        with huge.open("wb") as handle:
            handle.truncate(4 * 1024 ** 3)  # sparse: no disk, but 4 GB to read
        limit = 1024 ** 3

        def limited() -> None:
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))

        result = subprocess.run([sys.executable, "-B", str(ATLAS), "file", "--root", "Demo Ω",
                                 "--path", "docs/huge.md", "--json"], cwd=PROJECT, env=self.env, text=True,
                                capture_output=True, check=False, timeout=30, preexec_fn=limited)

        # Reading the file before comparing its size with the cap runs out of memory here.
        self.assertEqual((result.returncode, json.loads(result.stdout)["code"], json.loads(result.stdout)["message"]),
                         (0, "backend_error", "file exceeds 2 MB"))

    def test_root_through_a_symlink_is_stored_canonical_and_never_twice(self) -> None:
        alias = self.base / "alias"
        alias.symlink_to(self.root)
        config = self.config_home / "omarchy-atlas" / "config.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"version": 1, "roots": [{"name": "alias", "path": str(alias)}]}),
                          encoding="utf-8")

        result, duplicate = self.reply("root-add", str(self.root), "--name", "real")

        # Comparing the raw config path lets the canonical path in as a second root.
        self.assertEqual((result.returncode, duplicate["code"], duplicate["message"]),
                         (0, "invalid_root", "root path is already registered"))
        _result, listed = self.reply("roots")
        self.assertEqual(listed["data"]["config"]["roots"], [{"name": "alias", "path": str(self.root)}])

    def test_cache_is_not_rewritten_when_config_roots_are_unchanged(self) -> None:
        second = self.base / "second"
        second.mkdir()
        (second / "README.md").write_text("# Second\n", encoding="utf-8")
        alias = self.base / "alias"
        alias.symlink_to(self.root)
        config = self.config_home / "omarchy-atlas" / "config.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"version": 1, "roots": [
            {"name": "zeta", "path": str(alias)}, {"name": "alpha", "path": str(second)}]}), encoding="utf-8")
        cache = self.cache_home / "omarchy-atlas" / "index.json"

        self.reply("files")
        written = cache.stat().st_ino
        self.fresh(cache)
        result, reply = self.reply("files")

        # A raw symlinked path, or roots compared in config order, rebuilds and replaces the cache each call.
        self.assertEqual((result.returncode, reply["ok"]), (0, True))
        self.assertEqual(cache.stat().st_ino, written)

    def test_unreadable_document_returns_coded_json_without_partial_findings(self) -> None:
        blocked = self.root / "docs" / "blocked.md"
        blocked.write_text("# Blocked\n", encoding="utf-8")
        blocked.chmod(0)
        self.addCleanup(blocked.chmod, 0o644)

        result, reply = self.reply("orphans", "--path", str(self.root))

        self.assertEqual((result.returncode, result.stderr, reply["ok"], reply["code"]),
                         (0, "", False, "backend_error"))
        self.assertIn(str(blocked), reply["message"])
        self.assertNotIn("data", reply)

    def test_non_utf8_filename_is_ascii_escaped_at_json_boundary_and_cache(self) -> None:
        filename = "bad-" + os.fsdecode(b"\xff") + ".md"
        (self.root / filename).write_text("# Byte name\n", encoding="utf-8")
        self.add_root()

        result = subprocess.run([sys.executable, "-B", str(ATLAS), "orphans", "--root", "Demo Ω", "--json"],
                                cwd=PROJECT, env=self.env, capture_output=True, check=False, timeout=10)
        decoded = result.stdout.decode("utf-8", "strict")
        reply = json.loads(decoded)

        self.assertEqual((result.returncode, result.stderr, decoded.count("\n")), (0, b"", 1))
        self.assertIn("\\udcff", decoded)
        self.assertIn(filename, {item["path"] for item in reply["data"]["orphans"]})
        cache = self.cache_home / "omarchy-atlas" / "index.json"
        self.assertIn("\\udcff", cache.read_text(encoding="utf-8"))

    def test_sentence_period_ends_path_token_but_extension_continuation_does_not(self) -> None:
        (self.root / "design-review.md").write_text("# Review\n", encoding="utf-8")
        (self.root / "decoy.md").write_text("# Decoy\n", encoding="utf-8")
        (self.root / "docs" / "sentence.md").write_text(
            "See ../design-review.md. The backup is ../decoy.md.bak.\n", encoding="utf-8")

        result, reply = self.reply("orphans", "--path", str(self.root))

        self.assertEqual((result.returncode, reply["ok"]), (0, True))
        paths = {item["path"] for item in reply["data"]["orphans"]}
        self.assertNotIn("design-review.md", paths)
        self.assertIn("decoy.md", paths)

    def test_deleted_registered_root_is_listed_and_can_be_removed(self) -> None:
        self.add_root("gone")
        shutil.rmtree(self.root)

        result, listed = self.reply("roots")
        self.assertEqual((result.returncode, listed["data"]["config"]["roots"]),
                         (0, [{"name": "gone", "path": str(self.root), "missing": True}]))
        result, failed = self.reply("orphans", "--root", "gone")
        self.assertEqual((result.returncode, failed["ok"], failed["code"]), (0, False, "invalid_root"))
        self.assertIn(str(self.root), failed["message"])
        result, removed = self.reply("root-remove", "gone")
        self.assertEqual((result.returncode, removed["data"]["config"]["roots"]), (0, []))

    def test_deleted_root_stops_only_itself(self) -> None:
        self.add_root("demo")
        gone = self.base / "gone"
        gone.mkdir()
        _result, reply = self.reply("root-add", str(gone), "--name", "gone")
        self.assertTrue(reply["ok"])
        _result, reply = self.reply("files")
        gone.rmdir()

        # Restoring the invalid_root refusal for every root makes each reply below fail.
        missing = [{"root": "gone", "reason": "root missing"}]
        _result, reply = self.reply("index")
        self.assertEqual(([root["name"] for root in reply["data"]["index"]["roots"]],
                          reply["data"]["index"]["unavailable"][-1]), (["demo"], missing[0]))
        for command in ("files", "orphans", "dangling", "cost"):
            _result, reply = self.reply(command)
            self.assertEqual((command, reply["ok"], reply["data"]["unavailable"]), (command, True, missing))
        _result, reply = self.reply("search", "jalapeño")
        self.assertEqual((reply["data"]["matches"][0]["file"]["root"], reply["data"]["unavailable"]),
                         ("demo", missing))
        _result, reply = self.reply("stale")
        self.assertIn(missing[0], reply["data"]["unavailable"])
        for command in ("index", "files"):
            result = self.run_cli(command)
            self.assertEqual((command, result.returncode, result.stdout.splitlines()[-1]),
                             (command, 0, "unavailable\tgone\troot missing"))
        _result, failed = self.reply("files", "--root", "gone")
        self.assertEqual((failed["ok"], failed["code"]), (False, "invalid_root"))
        _result, failed = self.reply("file", "--root", "gone", "--path", "AGENTS.md")
        self.assertEqual((failed["ok"], failed["code"]), (False, "invalid_root"))
        gone.mkdir()
        (gone / "back.md").write_text("# Back\n", encoding="utf-8")
        _result, reply = self.reply("files", "--root", "gone")
        self.assertEqual(([item["path"] for item in reply["data"]["files"]], reply["data"]["unavailable"]),
                         (["back.md"], []))

    def test_reports_rebuild_a_saved_index_older_than_two_seconds(self) -> None:
        self.add_root()
        cache = self.cache_home / "omarchy-atlas" / "index.json"
        self.assertEqual(self.run_cli("orphans").returncode, 1)
        with (self.root / "README.md").open("a", encoding="utf-8") as readme:
            readme.write("[orphan](docs/orphan.md)\n")

        self.fresh(cache)
        self.assertEqual(self.run_cli("orphans").returncode, 1)
        old = time.time() - 3
        os.utime(cache, (old, old))
        result = self.run_cli("orphans")

        # Reading the saved index whatever its age still lists docs/orphan.md.
        self.assertEqual((result.returncode, result.stdout), (0, "No orphans.\n"))

    def test_root_deleted_before_its_first_index_is_reported_missing(self) -> None:
        self.add_root("demo")
        self.reply("files")
        gone = self.base / "gone"
        gone.mkdir()
        _result, reply = self.reply("root-add", str(gone), "--name", "gone")
        self.assertTrue(reply["ok"])
        gone.rmdir()
        self.fresh(self.cache_home / "omarchy-atlas" / "index.json")

        _result, reply = self.reply("orphans")

        # Comparing only the roots that exist keeps the saved index, which never named gone.
        self.assertEqual(reply["data"]["unavailable"], [{"root": "gone", "reason": "root missing"}])

    def test_gates_fail_when_every_registered_root_is_missing(self) -> None:
        self.add_root("gone")
        shutil.rmtree(self.root)

        # Without the check each gate prints only the unavailable line and exits 0.
        for command in ("orphans", "dangling", "stale"):
            result = self.run_cli(command)
            self.assertEqual((command, result.returncode, result.stdout, result.stderr),
                             (command, 3, "", f"atlas {command}: every registered root is missing\n"))
        _result, reply = self.reply("orphans")
        self.assertEqual((reply["ok"], reply["code"]), (False, "invalid_root"))
        _result, reply = self.reply("files")
        self.assertEqual((reply["ok"], reply["data"]["unavailable"]),
                         (True, [{"root": "gone", "reason": "root missing"}]))

    def test_broken_nested_checkout_stops_only_itself(self) -> None:
        broken = self.root / "broken"
        broken.mkdir()
        (broken / ".git").write_text("garbage\n", encoding="utf-8")
        (broken / "inside.md").write_text("# Inside\n", encoding="utf-8")
        second = self.base / "second"
        second.mkdir()
        (second / "README.md").write_text("# Second\n", encoding="utf-8")
        self.add_root("demo")
        _result, reply = self.reply("root-add", str(second))
        self.assertTrue(reply["ok"])

        _result, reply = self.reply("files")

        # Letting the git error through fails every root with git_error.
        self.assertEqual(([(item["root"], item["path"]) for item in reply["data"]["files"]],
                          reply["data"]["unavailable"]),
                         ([("demo", "AGENTS.md"), ("demo", "README.md"), ("demo", "docs/guide.md"),
                           ("demo", "docs/orphan.md"), ("second", "README.md")],
                          [{"root": "demo", "path": "broken", "reason": "git unavailable"}]))
        result = self.run_cli("orphans")
        self.assertEqual((result.returncode, result.stdout.splitlines()[-1]),
                         (1, "unavailable\tdemo:broken\tgit unavailable"))

    def test_root_lifecycle_index_files_and_json_frames(self) -> None:
        result, reply = self.reply("roots")
        self.assertEqual((result.returncode, result.stderr, reply["data"]["config"]["roots"]), (0, "", []))
        self.add_root()
        result, reply = self.reply("index", "--root", "Demo Ω")
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["data"]["index"]["summary"]["files"], 4)
        self.assertTrue((self.cache_home / "omarchy-atlas" / "index.json").is_file())
        result, reply = self.reply("files", "--root", "Demo Ω", "--kind", "doc")
        self.assertEqual([item["path"] for item in reply["data"]["files"]],
                         ["docs/guide.md", "docs/orphan.md"])
        result, reply = self.reply("root-remove", "Demo Ω")
        self.assertEqual(reply["data"]["config"]["roots"], [])

    def test_kind_commands_store_user_entries_and_restore_builtin_defaults(self) -> None:
        self.add_root()
        (self.root / "notes.txt").write_text("A note\n", encoding="utf-8")
        result, reply = self.reply("kinds")

        # Reordering the built-in table makes this red.
        self.assertEqual((result.returncode, [item["id"] for item in reply["data"]["kinds"]]),
                         (0, ["instruction", "readme", "decision", "runbook", "plan", "log", "archive", "generated", "diagram", "doc"]))
        _result, before = self.reply("files", "--root", "Demo Ω")
        self.assertNotIn("notes.txt", [item["path"] for item in before["data"]["files"]])
        result, reply = self.reply("kind-set", "notes", "--label", "Notes", "--colour", "#112233", "--ext", ".txt")
        self.assertEqual((result.returncode, reply["data"]["config"]["kinds"]),
                         (0, [{"id": "notes", "label": "Notes", "colour": "#112233", "match": {"extensions": [".txt"]}}]))
        _result, indexed = self.reply("files", "--root", "Demo Ω")
        self.assertIn("notes.txt", [item["path"] for item in indexed["data"]["files"]])
        _result, changed = self.reply("kind-set", "instruction", "--label", "Project instructions")
        self.assertEqual(changed["data"]["config"]["kinds"][1]["label"], "Project instructions")
        _result, restored = self.reply("kind-remove", "instruction")
        self.assertEqual(restored["data"]["config"]["kinds"], [{"id": "notes", "label": "Notes", "colour": "#112233", "match": {"extensions": [".txt"]}}])

    def test_custom_workflow_kind_tracks_yaml_only_after_kind_set(self) -> None:
        workflow = self.root / ".github" / "workflows" / "check.yml"
        workflow.parent.mkdir(parents=True)
        workflow.write_text("name: Check\n", encoding="utf-8")
        self.add_root()
        _result, before = self.reply("files", "--root", "Demo Ω")
        result, reply = self.reply(
            "kind-set", "workflow", "--ext", ".yml", "--path", ".github/workflows/",
        )
        _result, after = self.reply("files", "--root", "Demo Ω")

        # Removing either kind-set match argument keeps check.yml out of this exact result.
        self.assertEqual((result.returncode, reply["data"]["config"]["kinds"]), (0, [{
            "id": "workflow", "match": {
                "paths": [".github/workflows/"], "extensions": [".yml"],
            },
        }]))
        self.assertNotIn(".github/workflows/check.yml", [item["path"] for item in before["data"]["files"]])
        self.assertIn(".github/workflows/check.yml", [item["path"] for item in after["data"]["files"]])
        _result, changed = self.reply("kind-set", "workflow", "--path", "other/")
        self.assertEqual(changed["data"]["config"]["kinds"][0]["match"],
                         {"paths": ["other/"], "extensions": [".yml"]})
        _result, changed = self.reply("kind-set", "workflow", "--ext", ".yaml")
        self.assertEqual(changed["data"]["config"]["kinds"][0]["match"],
                         {"paths": ["other/"], "extensions": [".yaml"]})
        _result, changed = self.reply("kind-set", "workflow", "--ext=")
        self.assertEqual(changed["data"]["config"]["kinds"][0]["match"],
                         {"paths": ["other/"], "extensions": []})

    def test_env_deny_wins_over_user_kind(self) -> None:
        (self.root / ".env").write_text("TOKEN=secret\n", encoding="utf-8")
        (self.root / "project.env").write_text("TOKEN=also-secret\n", encoding="utf-8")
        self.add_root()
        result, reply = self.reply("kind-set", "x", "--ext", ".env")
        _result, indexed = self.reply("files", "--root", "Demo Ω")

        # Removing *.env from the deny list adds project.env to these paths.
        self.assertEqual((result.returncode, reply["data"]["config"]["kinds"]),
                         (0, [{"id": "x", "match": {"extensions": [".env"]}}]))
        self.assertFalse({".env", "project.env"} & {item["path"] for item in indexed["data"]["files"]})

    def test_credential_deny_list_refuses_file_lookups(self) -> None:
        (self.root / ".credentials.json").write_text('{"token":"secret"}\n', encoding="utf-8")
        self.add_root()
        _result, indexed = self.reply("index", "--root", "Demo Ω")

        # Removing the credential check indexes and reads this file.
        self.assertNotIn(".credentials.json", [item["path"] for item in indexed["data"]["index"]["files"]])
        result, denied = self.reply("file", "--root", "Demo Ω", "--path", ".credentials.json")
        self.assertEqual((result.returncode, denied["code"]), (0, "denied"))

    def test_root_add_names_the_filesystem_root_system(self) -> None:
        result, reply = self.reply("root-add", "/")

        # Replacing the root_path.name fallback with root_path.name makes this invalid_root.
        self.assertEqual((result.returncode, result.stderr, reply), (0, "", {
            "version": 1,
            "ok": True,
            "command": "root-add",
            "data": {"config": {"version": 1, "roots": [{"name": "system", "path": "/"}]}},
        }))

    def test_ad_hoc_path_never_reads_or_writes_state_and_file_path_is_relative(self) -> None:
        invalid = self.config_home / "omarchy-atlas" / "config.json"
        invalid.parent.mkdir(parents=True)
        invalid.write_text("{broken", encoding="utf-8")
        before = invalid.read_bytes()
        result, reply = self.reply("files", "--path", str(self.root))
        self.assertEqual((result.returncode, reply["ok"]), (0, True))
        self.assertEqual(invalid.read_bytes(), before)
        self.assertFalse(self.cache_home.exists())
        result, reply = self.reply("file", "--root", "Demo Ω", "--path", "docs/guide.md")
        self.assertEqual((result.returncode, reply["code"]), (0, "config_invalid"))
        malformed = self.run_cli("file", "--path", str(self.root), "--json")
        self.assertEqual(malformed.returncode, 2)
        self.assertEqual(malformed.stdout, "")
        self.assertIn("--root", malformed.stderr)

    def test_findings_search_cost_and_human_gate_status(self) -> None:
        self.add_root()
        _result, reply = self.reply("orphans", "--root", "Demo Ω", "--all")
        self.assertEqual([item["path"] for item in reply["data"]["orphans"]], ["docs/orphan.md"])
        self.assertEqual({item["path"] for item in reply["data"]["exempt"]}, {"AGENTS.md", "README.md"})
        _result, reply = self.reply("dangling", "--root", "Demo Ω")
        self.assertEqual(reply["data"]["dangling"][0]["text"], "[Missing document](missing.md)")
        _result, reply = self.reply("stale", "--root", "Demo Ω")
        self.assertEqual(reply["data"], {"stale": [], "unavailable": [{"root": "Demo Ω", "reason": "impact map absent"}]})
        self.assertEqual(self.run_cli("orphans", "--root", "Demo Ω").returncode, 1)
        self.assertEqual(self.run_cli("stale", "--root", "Demo Ω").returncode, 0)

        _result, reply = self.reply("search", "JALAPEÑO", "--root", "Demo Ω")
        match = reply["data"]["matches"][0]
        self.assertEqual((match["file"]["path"], match["line"], match["text"]),
                         ("docs/guide.md", 3, "The Unicode needle is jalapeño."))
        (self.home / ".codex").mkdir(parents=True)
        (self.home / ".codex" / "AGENTS.md").write_text("five", encoding="utf-8")
        _result, reply = self.reply("cost", "--root", "Demo Ω")
        [codex] = reply["data"]["roots"]
        self.assertEqual([(item["path"], item["tokensApprox"]) for item in codex["startup"]],
                         [("AGENTS.md", 22), (str(self.home / ".codex" / "AGENTS.md"), 1)])
        self.assertEqual([item["path"] for item in codex["referenced"]], ["docs/guide.md"])
        self.assertEqual((codex["startupBytes"], codex["startupTokensApprox"]), (90, 23))
        self.assertEqual(codex["referencedBytes"], codex["referenced"][0]["bytes"])
        self.assertIn("approximate", self.run_cli("cost", "--root", "Demo Ω").stdout)

    def test_search_skips_oversized_content_but_matches_its_path(self) -> None:
        big = self.root / "docs" / "large-needle.md"
        big.write_bytes(b"hidden phrase\n" + b"x" * atlas_index.MAX_FILE_BYTES)
        result, reply = self.reply("search", "hidden phrase", "--path", str(self.root))
        self.assertEqual((result.returncode, reply["data"]["matches"]), (0, []))
        self.assertIn({"root": self.root.name, "path": "docs/large-needle.md",
                       "reason": "content exceeds 2 MB"}, reply["data"]["unavailable"])
        _result, reply = self.reply("search", "large-needle", "--path", str(self.root))
        self.assertEqual([(item["file"]["path"], item["line"]) for item in reply["data"]["matches"]],
                         [("docs/large-needle.md", 0)])

    def test_search_reports_oversized_file_after_match_limit(self) -> None:
        (self.root / "a.md").write_text("cap-needle\n" * 200, encoding="utf-8")
        (self.root / "z.md").write_bytes(b"x" * (atlas_index.MAX_FILE_BYTES + 1))
        result, reply = self.reply("search", "cap-needle", "--path", str(self.root))
        self.assertEqual(result.returncode, 0)
        self.assertEqual([(item["file"]["path"], item["line"]) for item in reply["data"]["matches"]],
                         [("a.md", line) for line in range(1, 201)])
        self.assertIn({"root": self.root.name, "path": "z.md",
                       "reason": "content exceeds 2 MB"}, reply["data"]["unavailable"])

    def test_encoded_markdown_target_has_no_dangling_or_orphan_finding(self) -> None:
        root = self.base / "encoded"
        root.mkdir()
        (root / "My File.md").write_text("# Target\n", encoding="utf-8")
        (root / "README.md").write_text("[Target](My%20File.md)\n", encoding="utf-8")
        for command in ("dangling", "orphans"):
            result, reply = self.reply(command, "--path", str(root))
            self.assertEqual((result.returncode, reply["data"][command]), (0, []))

    def test_dangling_table_omits_inline_code_examples(self) -> None:
        result = self.run_cli("dangling", "--path", str(INDEX_FIXTURE))

        # Matching _MARKDOWN or _WIKILINK against line instead of link_line adds inline-* rows here.
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "")
        self.assertEqual(result.stdout.splitlines(), [
            "plain:docs/inline-code.md:6\t[[prose-wiki]]",
            "plain:docs/inline-code.md:7\t[Prose markdown](prose-markdown.md)",
        ])
        self.assertNotIn("inline-single", result.stdout)
        self.assertNotIn("inline-double", result.stdout)

    def test_global_cost_input_contributes_registered_pointer_target(self) -> None:
        self.add_root("demo")
        global_file = self.home / ".codex" / "AGENTS.md"
        global_file.parent.mkdir(parents=True)
        target = self.root / "docs" / "guide.md"
        global_file.write_text(f"Read [the guide](<{target}>).\n", encoding="utf-8")

        _result, reply = self.reply("cost", "--root", "demo")
        codex = next(row for row in reply["data"]["roots"] if row["agent"] == "codex")
        self.assertEqual([item["path"] for item in codex["startup"]], ["AGENTS.md", str(global_file)])
        self.assertEqual([item["path"] for item in codex["referenced"]], ["docs/guide.md"])

        _result, files_reply = self.reply("files", "--root", "demo")
        self.assertNotIn(str(global_file), [item["path"] for item in files_reply["data"]["files"]])

    def test_cost_for_one_root_keeps_a_reference_into_another_root(self) -> None:
        alpha, beta = self.base / "alpha", self.base / "beta"
        alpha.mkdir()
        beta.mkdir()
        (beta / "guide.md").write_text("# Guide\n", encoding="utf-8")
        (alpha / "AGENTS.md").write_text(f"Read {beta / 'guide.md'} first.\n", encoding="utf-8")
        for root in (alpha, beta):
            _result, reply = self.reply("root-add", str(root))
            self.assertTrue(reply["ok"])

        _result, reply = self.reply("cost", "--root", "alpha")
        # Computing cost on the --root view drops beta's guide from referenced.
        self.assertEqual([(row["agent"], [item["path"] for item in row["referenced"]])
                          for row in reply["data"]["roots"]], [("codex", ["beta:guide.md"])])

    def test_invalid_missing_failed_and_unavailable_inputs_are_distinct(self) -> None:
        config = self.config_home / "omarchy-atlas" / "config.json"
        config.parent.mkdir(parents=True)
        config.write_text("not json", encoding="utf-8")
        result, reply = self.reply("files")
        self.assertEqual((result.returncode, reply["ok"], reply["code"]), (0, False, "config_invalid"))
        self.assertEqual(config.read_text(encoding="utf-8"), "not json")
        config.unlink()
        result, reply = self.reply("files")
        self.assertEqual((result.returncode, reply["code"]), (0, "no_roots"))
        self.add_root()
        result, reply = self.reply("file", "--root", "Demo Ω", "--path", "docs/missing.md")
        self.assertEqual((result.returncode, reply["code"]), (0, "not_found"))
        result, reply = self.reply("file", "--root", "Demo Ω", "--path", "../outside.md")
        self.assertEqual((result.returncode, reply["code"]), (0, "outside_roots"))
        result, reply = self.reply("files", "--root", "absent")
        self.assertEqual((result.returncode, reply["code"]), (0, "not_found"))
        (self.root / "docs" / "impact.yml").write_text("not json", encoding="utf-8")
        self.run_cli("index", "--root", "Demo Ω", "--json")
        _result, reply = self.reply("stale", "--root", "Demo Ω")
        self.assertEqual(reply["data"]["unavailable"][0]["reason"], "impact map unreadable")

    def test_edit_and_show_launchers_preserve_spaces_unicode_and_argv(self) -> None:
        self._test_credential()
        self.add_root()
        result, reply = self.reply("edit", "--root", "Demo Ω", "--path", "docs/guide.md")
        self.assertEqual((result.returncode, reply["data"]), (0, {"opened": True}))
        self.assertEqual(self.launcher_rows(), [[str(self.root / "docs" / "guide.md")]])

        reader = self.base / "reader"
        shutil.copytree(SERVE_READER, reader)
        config_path = self.config_home / "omarchy-atlas" / "config.json"
        cache_path = self.cache_home / "omarchy-atlas" / "index.json"
        server = atlas_serve.create_server(port=0, config_path=config_path, cache_path=cache_path,
                                           reader_dir=reader, theme_dir=self.base / "theme",
                                           shell_override_path=self.base / "shell.toml",
                                           rounding_command=None)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        self.addCleanup(self._stop_server, server, thread)
        env = dict(self.env)
        env["ATLAS_SERVER_URL"] = f"http://127.0.0.1:{server.server_address[1]}"
        stdio_log = self.base / "stdio.jsonl"
        child_state = self.base / "launcher-child"
        env["ATLAS_STDIO_LOG"] = str(stdio_log)
        env["ATLAS_LAUNCH_CHILD_STATE"] = str(child_state)
        result, reply = self.reply("show", "--root", "Demo Ω", "--path", "docs/guide.md", "--map", env=env)
        self.assertEqual((result.returncode, reply["data"]), (0, {"clients": 0}))
        launched = self.launcher_rows()[1]
        self.assertEqual(launched[0], "Markdown Atlas Reader")
        self.assertTrue(launched[1].startswith("file://"))
        self.assertNotIn(self.env["ATLAS_TEST_SERVER_SECRET"], launched[1])
        self.assertIn("/map/Demo%20%CE%A9/docs/guide.md", Path(launched[1][7:]).read_text(encoding="utf-8"))
        self.assertNotEqual(child_state.read_text(encoding="utf-8"), "finished")
        streams = json.loads(stdio_log.read_text(encoding="utf-8"))
        self.assertEqual(streams, {"stdoutPipe": False, "stderrPipe": False})
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and child_state.read_text(encoding="utf-8") != "finished":
            time.sleep(0.02)
        self.assertEqual(child_state.read_text(encoding="utf-8"), "finished")

    def test_launcher_failures_keep_server_unavailable_cli_error(self) -> None:
        self._test_credential()
        self.add_root()
        env = dict(self.env)
        env["ATLAS_LAUNCH_EXIT"] = "7"
        for command in ("edit", "show"):
            result, reply = self.reply(command, "--root", "Demo Ω", "--path", "docs/guide.md", env=env)
            self.assertEqual((result.returncode, reply["ok"], reply["code"]),
                             (0, False, "server_unavailable"))

    def test_show_refuses_server_override_without_explicit_test_credential(self) -> None:
        self.add_root()
        env = dict(self.env)
        result, reply = self.reply("show", "--root", "Demo Ω", "--path", "docs/guide.md", env=env)
        self.assertEqual((result.returncode, reply["code"]), (0, "server_unavailable"))
        env["ATLAS_SERVER_URL"] = "http://attacker.example:4137"
        env["ATLAS_TEST_SERVER_SECRET"] = "a" * 64
        result, reply = self.reply("show", "--root", "Demo Ω", "--path", "docs/guide.md", env=env)
        self.assertEqual((result.returncode, reply["code"]), (0, "server_unavailable"))
        self.assertFalse(self.argv_log.exists())

    def _stop_server(self, server: atlas_serve.AtlasHTTPServer, thread: threading.Thread) -> None:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())

    def test_serve_command_runs_real_ephemeral_http_server(self) -> None:
        self._test_credential()
        self.add_root()
        process = subprocess.Popen([sys.executable, "-B", str(ATLAS), "serve", "--port", "0"],
                                   cwd=PROJECT, env=self.env, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        self.addCleanup(self._stop_process, process)
        self.assertTrue(select.select([process.stdout], [], [], 5)[0])
        port = int(process.stdout.readline().strip())
        deadline = time.monotonic() + 5
        body = None
        while time.monotonic() < deadline:
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.2)
                connection.request("GET", "/api/index", headers={"Authorization": "Bearer " + self.env["ATLAS_TEST_SERVER_SECRET"]})
                response = connection.getresponse()
                body = response.read()
                connection.close()
                break
            except OSError:
                time.sleep(0.02)
        self.assertIsNotNone(body)
        self.assertEqual(json.loads(body)["summary"]["files"], 4)

    def _stop_process(self, process: subprocess.Popen[str]) -> None:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=3)
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()

    def test_wrapper_finds_atlas_through_a_symlink(self) -> None:
        link = self.home / ".local" / "bin" / "atlas"
        link.parent.mkdir(parents=True)
        link.symlink_to(WRAPPER)

        result = subprocess.run([str(link), "roots", "--json"], cwd=self.base, env=self.env,
                                text=True, capture_output=True, check=False, timeout=10)

        # dirname "$0" without readlink -f looks for ~/.local/atlas.py.
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        self.assertEqual(json.loads(result.stdout)["data"]["config"]["roots"], [])

    def test_help_describes_every_command_in_a_stable_order(self) -> None:
        expected = [
            ("roots", "list registered roots"),
            ("root-add", "register a directory as a root"),
            ("root-remove", "unregister a root"),
            ("kinds", "list the effective kind table"),
            ("kind-set", "create or change a kind"),
            ("kind-remove", "remove a kind entry; a built-in returns to its default"),
            ("index", "rebuild the index and write the cache"),
            ("files", "list indexed files"),
            ("orphans", "list files that nothing refers to"),
            ("dangling", "list references whose target does not exist"),
            ("stale", "list files older than the sources they describe"),
            ("cost", "show the size of the instruction files an agent loads"),
            ("search", "search paths, titles and content"),
            ("file", "print an indexed file"),
            ("show", "open an indexed file in the reader"),
            ("edit", "open an indexed file in the editor"),
            ("serve", "run the reader server"),
        ]
        for seed in ("1", "2", "3"):
            result = self.run_cli("--help", env={**self.env, "PYTHONHASHSEED": seed})
            rows = [line.split(None, 1) for line in result.stdout.splitlines()
                    if line.startswith("    ") and not line.startswith("     ")]

            # A set of command names, or a subparser without help=, changes these rows.
            self.assertEqual((result.returncode, [tuple(row) for row in rows]), (0, expected))

    def test_text_mode_errors_exit_3_apart_from_findings(self) -> None:
        no_roots = self.run_cli("orphans")
        missing = self.run_cli("orphans", "--path", str(self.base / "absent"))
        framed = self.run_cli("orphans", "--json")

        # Returning 1 for a reported error makes it look like a gate finding.
        self.assertEqual((no_roots.returncode, no_roots.stdout, no_roots.stderr),
                         (3, "", "atlas orphans: no roots are configured\n"))
        self.assertEqual((missing.returncode, missing.stdout), (3, ""))
        self.assertIn("root does not exist", missing.stderr)
        self.assertEqual((framed.returncode, json.loads(framed.stdout)["code"]), (0, "no_roots"))
        self.assertEqual(self.run_cli("orphans", "--path", str(self.root)).returncode, 1)

    def test_wrapper_executes_python3_dash_b(self) -> None:
        fake_bin = self.base / "fake-bin"
        fake_bin.mkdir()
        fake_python = fake_bin / "python3"
        fake_python.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\"\n", encoding="utf-8")
        fake_python.chmod(0o755)
        env = dict(self.env)
        env["PATH"] = str(fake_bin) + os.pathsep + env["PATH"]
        result = subprocess.run([str(WRAPPER), "roots", "--json"], cwd=PROJECT, env=env,
                                text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[0], "-B")
        self.assertEqual(Path(lines[1]).resolve(), ATLAS)
        self.assertEqual(lines[2:], ["roots", "--json"])


if __name__ == "__main__":
    unittest.main()
