"""Behaviour tests for the contract-owned index boundary."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import atlas_index


FIXTURE = Path(__file__).parent / "fixtures" / "index" / "plain"
DRIVE_FIXTURE = Path(__file__).parent / "fixtures" / "index" / "drive"
KINDS_FIXTURE = Path(__file__).parent / "fixtures" / "index" / "kinds"


class IndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def plain_root(self) -> Path:
        root = self.base / "plain"
        shutil.copytree(FIXTURE, root)
        (root / "src").mkdir()
        (root / "src" / "main.py").write_text("print('source')\n", encoding="utf-8")
        for position, path in enumerate(sorted(root.rglob("*"))):
            if path.is_file():
                os.utime(path, (1_700_000_000 + position, 1_700_000_000 + position))
        return root

    def kinds_root(self) -> Path:
        root = self.base / "kinds"
        shutil.copytree(KINDS_FIXTURE, root)
        return root

    def test_builtin_kind_table_order_and_defaults_match_the_checkpoint_fixture(self) -> None:
        root = self.kinds_root()

        # Reordering BUILTIN_KINDS or changing a default makes this red.
        self.assertEqual(atlas_index.index_path(root)["kinds"],
                         json.loads((KINDS_FIXTURE / "expected-kinds.json").read_text(encoding="utf-8")))

    def test_default_kinds_exclude_neighbouring_non_markdown_files(self) -> None:
        root = self.kinds_root()
        files = {item["path"]: item for item in atlas_index.index_path(root)["files"]}

        # Adding a non-Markdown extension to a built-in makes this exact list red.
        self.assertEqual(list(files), ["docs/link.md"])

    def test_custom_workflow_kind_tracks_yaml_and_resolves_its_markdown_link(self) -> None:
        root = self.kinds_root()
        default = atlas_index.index_path(root)
        config = atlas_index.set_kind(
            {"version": 1, "roots": []}, "workflow",
            paths=[".github/workflows/"], extensions=[".yml"],
        )

        # Restoring .github to the unconditional allow-list adds hidden.md here;
        # replacing the named-kind condition with an unconditional skip removes check.yml below.
        self.assertFalse({".github/hidden.md", ".github/workflows/check.yml"}
                         & {item["path"] for item in default["files"]})
        index = atlas_index.build_index([{"name": "kinds", "path": str(root)}], kinds=config["kinds"])
        self.assertNotIn(".github/hidden.md", {item["path"] for item in index["files"]})
        workflow = next(item for item in index["files"] if item["path"] == ".github/workflows/check.yml")
        self.assertEqual((workflow["kind"], workflow["type"], workflow["title"]),
                         ("workflow", ".yml", "check.yml"))
        references = [item for item in index["references"] if item["from"]["path"] == "docs/link.md"]

        # Removing the non-document unresolved guard adds missing.png; changing the suffix
        # test to include .md removes missing.md; skipping resolution removes the workflow.
        self.assertEqual([(item["text"], item["resolved"], item["to"]) for item in references], [
            ("[The workflow](../.github/workflows/check.yml)", True,
             {"root": "kinds", "path": ".github/workflows/check.yml"}),
            ("[Missing document](missing.md)", False, None),
        ])

    def test_hidden_directory_glob_opens_and_matches_only_its_kind(self) -> None:
        root = self.kinds_root()
        config = atlas_index.set_kind(
            {"version": 1, "roots": []}, "private", paths=["**/.private/"],
        )

        index = atlas_index.build_index([{"name": "kinds", "path": str(root)}], kinds=config["kinds"])
        private = next(item for item in index["files"] if item["path"] == ".private/note.md")

        self.assertEqual(private["kind"], "private")

    def test_literal_hidden_directory_path_still_opens_and_matches_its_kind(self) -> None:
        root = self.kinds_root()
        config = atlas_index.set_kind(
            {"version": 1, "roots": []}, "private", paths=[".private/"],
        )

        index = atlas_index.build_index([{"name": "kinds", "path": str(root)}], kinds=config["kinds"])
        private = next(item for item in index["files"] if item["path"] == ".private/note.md")

        self.assertEqual(private["kind"], "private")

    def test_nonmatching_hidden_directory_glob_does_not_open_directory(self) -> None:
        root = self.kinds_root()
        config = atlas_index.set_kind(
            {"version": 1, "roots": []}, "private", paths=["**/.secret/"],
        )

        index = atlas_index.build_index([{"name": "kinds", "path": str(root)}], kinds=config["kinds"])

        self.assertNotIn(".private/note.md", {item["path"] for item in index["files"]})

    def test_custom_extension_adds_notes_and_override_then_remove_restores_instruction(self) -> None:
        root = self.kinds_root()
        config = {"version": 1, "roots": []}
        config = atlas_index.set_kind(config, "notes", label="Notes", colour="#112233", extensions=[".txt"])

        # Removing --ext support from the first-match table leaves notes.txt absent.
        with_notes = atlas_index.build_index([{"name": "kinds", "path": str(root)}], kinds=config["kinds"])
        self.assertEqual(next(item for item in with_notes["files"] if item["path"] == "notes.txt")["kind"], "notes")
        config = atlas_index.set_kind(config, "instruction", label="Local instructions")
        overridden = atlas_index.effective_kinds(config["kinds"])[1]
        self.assertEqual((overridden["label"], overridden["match"], overridden["overridden"]),
                         ("Local instructions", atlas_index.effective_kinds()[0]["match"], True))
        config = atlas_index.remove_kind(config, "instruction")
        restored = next(item for item in atlas_index.effective_kinds(config["kinds"]) if item["id"] == "instruction")
        self.assertEqual((restored["label"], restored["overridden"]), ("Agent instructions", False))

    def test_credential_deny_list_excludes_discovery(self) -> None:
        root = self.kinds_root()
        index = atlas_index.index_path(root)
        files = {item["path"] for item in index["files"]}

        # Removing the deny check exposes .credentials.json.
        self.assertNotIn(".credentials.json", files)
        self.assertTrue(atlas_index.denied_path(".credentials.json"))

    def test_ad_hoc_index_extracts_styles_fences_and_facts(self) -> None:
        root = self.plain_root()
        index = atlas_index.index_path(root, generated_at="2024-01-01T00:00:00Z")
        files = {item["path"]: item for item in index["files"]}
        references = [(item["style"], item["line"], item["text"], item["resolved"]) for item in index["references"]]

        self.assertEqual(index["roots"], [{"name": "plain", "path": str(root.resolve()), "git": False, "impact": "present"}])
        self.assertEqual([item["path"] for item in index["files"]],
                         ["AGENTS.md", "docs/adr/one.md", "docs/guide.md", "docs/inline-code.md"])
        # Matching _MARKDOWN and _WIKILINK against line instead of link_line adds the four inline-code examples.
        # Matching _PATH against link_line instead of line removes the path token inside backticks.
        self.assertEqual(references, [
            ("path", 3, "docs/guide.md", True),
            ("markdown", 3, "[Decision](adr/one.md)", True),
            ("wikilink", 4, "[[one]]", True),
            ("path", 5, "docs/guide.md", True),
            ("impact", 1, "docs/guide.md", True),
            ("wikilink", 6, "[[prose-wiki]]", False),
            ("markdown", 7, "[Prose markdown](prose-markdown.md)", False),
            ("path", 8, "docs/guide.md", True),
        ])
        self.assertEqual(files["AGENTS.md"]["kind"], "instruction")
        self.assertEqual(files["docs/adr/one.md"]["kind"], "decision")
        self.assertEqual(files["docs/guide.md"]["inbound"], 4)
        self.assertEqual(files["docs/guide.md"]["outbound"], 3)
        self.assertEqual(files["docs/inline-code.md"]["outbound"], 3)
        self.assertEqual(files["docs/inline-code.md"]["dangling"], 2)
        self.assertEqual(files["AGENTS.md"]["dangling"], 0)
        self.assertTrue(files["docs/adr/one.md"]["orphan"] is False)
        self.assertEqual(index["summary"]["dangling"], 2)
        self.assertEqual(index["summary"]["orphans"], 1)
        self.assertEqual(index["summary"]["stale"], 1)
        self.assertEqual(files["docs/guide.md"]["stale"]["rule"], "impact.yml#1")
        self.assertTrue(all(item["timeSource"] == "mtime" for item in files.values()))

    def test_paths_need_a_slash_or_local_basename_and_duplicate_wikis_dangle(self) -> None:
        root = self.plain_root()
        (root / "docs" / "a").mkdir()
        (root / "docs" / "b").mkdir()
        (root / "docs" / "a" / "same.md").write_text("# A\n", encoding="utf-8")
        (root / "docs" / "b" / "same.md").write_text("# B\n", encoding="utf-8")
        (root / "docs" / "guide.md").write_text("# Guide\n[[same]]\n[missing](missing.md)\nordinary.md\n", encoding="utf-8")
        index = atlas_index.index_path(root)
        refs = [item for item in index["references"] if item["from"]["path"] == "docs/guide.md"]
        self.assertEqual([(item["style"], item["text"], item["resolved"]) for item in refs], [
            ("wikilink", "[[same]]", False), ("markdown", "[missing](missing.md)", False),
        ])
        guide = next(item for item in index["files"] if item["path"] == "docs/guide.md")
        self.assertEqual(guide["dangling"], 2)

    def test_unclosed_backtick_run_does_not_mask_a_link(self) -> None:
        root = self.plain_root()
        (root / "docs" / "unclosed.md").write_text("# Unclosed\n`[[missing]]\n", encoding="utf-8")

        index = atlas_index.index_path(root)
        references = [item for item in index["references"] if item["from"]["path"] == "docs/unclosed.md"]

        # Masking from opener.start() when closer is None would remove this unresolved wikilink.
        self.assertEqual([(item["style"], item["line"], item["text"], item["resolved"])
                          for item in references], [("wikilink", 2, "[[missing]]", False)])

    def test_plain_walk_excludes_noise_and_escaping_symlinks(self) -> None:
        root = self.plain_root()
        (root / "node_modules").mkdir()
        (root / "node_modules" / "hidden.md").write_text("# hidden\n", encoding="utf-8")
        outside = self.base / "outside.md"
        outside.write_text("# outside\n", encoding="utf-8")
        (root / "escape.md").symlink_to(outside)
        index = atlas_index.index_path(root)
        self.assertNotIn("node_modules/hidden.md", {item["path"] for item in index["files"]})
        self.assertNotIn("escape.md", {item["path"] for item in index["files"]})

    def test_walked_root_delegates_nested_checkouts_to_git(self) -> None:
        root = self.base / "drive"
        shutil.copytree(DRIVE_FIXTURE, root)
        for checkout in (root / "projects" / "alpha", root / "projects" / "deeper" / "beta"):
            self.git(checkout, "init")
            self.git(checkout, "add", ".")
            self.git(checkout, "-c", "user.name=Atlas", "-c", "user.email=atlas@example.test",
                     "commit", "-m", "fixture")

        index = atlas_index.index_path(root, generated_at="2024-01-01T00:00:00Z")

        # Removing the _git_paths branch adds projects/alpha/artifacts/ignored.md here.
        self.assertEqual([item["path"] for item in index["files"]], [
            "README.md",
            "projects/alpha/tracked.md",
            "projects/deeper/beta/tracked.md",
        ])
        self.assertEqual(index["roots"], [{
            "name": "drive", "path": str(root), "git": False, "impact": "absent",
        }])

    def test_hidden_directory_is_only_indexed_as_its_own_root(self) -> None:
        root = self.base / "drive"
        shutil.copytree(DRIVE_FIXTURE, root)

        drive = atlas_index.index_path(root)
        hidden = atlas_index.index_path(root / ".private")

        # Removing item.startswith(".") adds .private/hidden.md to the drive result.
        self.assertEqual([item["path"] for item in drive["files"]], [
            "README.md",
            "projects/alpha/artifacts/ignored.md",
            "projects/alpha/tracked.md",
            "projects/deeper/beta/tracked.md",
        ])
        self.assertEqual([item["path"] for item in hidden["files"]], ["hidden.md"])

    def test_system_root_prunes_fixed_top_level_directories(self) -> None:
        walked_directories = ["proc", "sys", "dev", "run", "tmp", "boot", "lost+found", "etc"]

        def one_level_walk(_root: Path, *, followlinks: bool):
            self.assertFalse(followlinks)
            yield "/", walked_directories, []

        with mock.patch.object(atlas_index.os, "walk", one_level_walk):
            atlas_index._walk_paths(Path("/"))

        # Removing the SYSTEM_WALK_EXCLUDES condition leaves all seven fixed names here.
        self.assertEqual(walked_directories, ["etc"])

    def test_walked_root_does_not_cross_filesystems(self) -> None:
        root = self.base / "drive"
        root.mkdir()
        (root / "same-device").mkdir()
        (root / "mounted").mkdir()
        walked_directories = ["same-device", "mounted"]
        actual_stat = Path.stat

        def one_level_walk(_root: Path, *, followlinks: bool):
            self.assertFalse(followlinks)
            yield str(root), walked_directories, []

        def device_stat(path: Path, *args, **kwargs):
            value = actual_stat(path, *args, **kwargs)
            if path == root / "mounted":
                values = list(value)
                values[2] += 1
                return os.stat_result(values)
            return value

        with (mock.patch.object(atlas_index.os, "walk", one_level_walk),
              mock.patch.object(Path, "stat", device_stat)):
            atlas_index._walk_paths(root)

        # Removing the st_dev comparison leaves mounted in the directories walked.
        self.assertEqual(walked_directories, ["same-device"])

    def test_internal_document_aliases_deduplicate_except_instruction_entry_points(self) -> None:
        root = self.plain_root()
        (root / "docs" / "guide-alias.md").symlink_to("guide.md")
        (root / "CLAUDE.md").symlink_to("AGENTS.md")
        (root / "docs" / "ref.md").write_text("# Ref\n[alias](guide-alias.md)\n", encoding="utf-8")
        index = atlas_index.index_path(root)
        paths = [item["path"] for item in index["files"]]
        self.assertNotIn("docs/guide-alias.md", paths)
        self.assertIn("AGENTS.md", paths)
        self.assertIn("CLAUDE.md", paths)
        alias_reference = next(item for item in index["references"] if item["from"]["path"] == "docs/ref.md")
        self.assertEqual(alias_reference["to"], {"root": "plain", "path": "docs/guide.md"})

    def test_impact_unavailable_states_are_recorded_once(self) -> None:
        root = self.plain_root()
        (root / "docs" / "impact.yml").write_text("not json", encoding="utf-8")
        unreadable = atlas_index.index_path(root)
        self.assertEqual(unreadable["roots"][0]["impact"], "unreadable")
        self.assertEqual(unreadable["unavailable"], [{"root": "plain", "reason": "impact map unreadable"}])
        (root / "docs" / "impact.yml").unlink()
        absent = atlas_index.index_path(root)
        self.assertEqual(absent["roots"][0]["impact"], "absent")
        self.assertEqual(absent["unavailable"], [{"root": "plain", "reason": "impact map absent"}])

    def test_impact_map_above_2_mb_or_100000_references_is_unreadable_not_partial(self) -> None:
        root = self.plain_root()
        impact = root / "docs" / "impact.yml"
        impact.write_text('{"rules": []}' + " " * atlas_index.MAX_FILE_BYTES, encoding="utf-8")
        oversized = atlas_index.index_path(root)
        documents = len(oversized["files"])
        # Enough copies of one rule over every document to pass 100,000 references.
        rule = {"source": ["src/**"], "docs": ["**"]}
        impact.write_text(json.dumps({"rules": [rule] * (100_000 // documents + 1)}), encoding="utf-8")
        crowded = atlas_index.index_path(root)

        # Reading the map without a size cap makes it present with no rules; building
        # every reference makes the second present, with every document stale.
        for index, reason in ((oversized, "impact map exceeds 2 MB"),
                              (crowded, "impact map exceeds 100000 references")):
            self.assertEqual((index["roots"][0]["impact"], index["unavailable"], index["summary"]["stale"],
                              [item for item in index["references"] if item["style"] == "impact"]),
                             ("unreadable", [{"root": "plain", "reason": reason}], 0, []))

    def test_link_text_and_target_admit_one_level_of_brackets(self) -> None:
        root = self.base / "brackets"
        (root / "docs").mkdir(parents=True)
        (root / "docs" / "a[1].md").write_text("# A1\n", encoding="utf-8")
        (root / "docs" / "index.md").write_text("# Index\n[see [1]](a[1].md)\n", encoding="utf-8")

        index = atlas_index.index_path(root)

        # Refusing brackets in the target makes a[1].md an orphan with no reference.
        self.assertEqual([(item["text"], item["to"]) for item in index["references"]],
                         [("[see [1]](a[1].md)", {"root": "brackets", "path": "docs/a[1].md"})])

    def test_mixed_impact_times_are_unavailable_not_compared(self) -> None:
        root = self.base / "mixed"
        (root / "docs").mkdir(parents=True)
        (root / "src").mkdir()
        (root / "docs" / "guide.md").write_text("# Guide\n", encoding="utf-8")
        (root / "docs" / "impact.yml").write_text('{"rules":[{"source":["src/**"],"docs":["docs/guide.md"]}]}', encoding="utf-8")
        self.git(root, "init")
        self.git(root, "add", "docs")
        self.git(root, "-c", "user.name=Atlas", "-c", "user.email=atlas@example.test", "commit", "-m", "fixed")
        (root / "src" / "new.py").write_text("source\n", encoding="utf-8")
        index = atlas_index.index_path(root)
        guide = next(item for item in index["files"] if item["path"] == "docs/guide.md")
        self.assertIsNone(guide["stale"])
        self.assertEqual(index["unavailable"], [{"root": "mixed", "path": "docs/guide.md", "reason": "mixed time sources"}])

    def test_reference_precedence_repetitions_and_orphans_are_exact(self) -> None:
        root = self.base / "references"
        (root / "docs").mkdir(parents=True)
        (root / "same.md").write_text("# Root\n", encoding="utf-8")
        (root / "docs" / "same.md").write_text("# Local\n", encoding="utf-8")
        (root / "docs" / "note.md").write_text(
            "# Note\n[local](same.md) same.md same.md\n", encoding="utf-8")
        index = atlas_index.index_path(root)
        refs = [item for item in index["references"] if item["from"]["path"] == "docs/note.md"]
        self.assertEqual([(item["style"], item["text"], item["to"]["path"]) for item in refs], [
            ("markdown", "[local](same.md)", "docs/same.md"),
            ("path", "same.md", "docs/same.md"),
            ("path", "same.md", "docs/same.md"),
        ])
        files = {item["path"]: item for item in index["files"]}
        self.assertEqual(files["docs/same.md"]["inbound"], 3)
        self.assertEqual([item["path"] for item in index["files"] if item["orphan"]], ["docs/note.md", "same.md"])

    def test_git_discovery_respects_gitignore_and_commits_but_untracked_uses_mtime(self) -> None:
        root = self.base / "git"
        root.mkdir()
        (root / ".gitignore").write_text("ignored/\n", encoding="utf-8")
        (root / "tracked.md").write_text("# tracked\n", encoding="utf-8")
        (root / "ignored").mkdir()
        (root / "ignored" / "no.md").write_text("# no\n", encoding="utf-8")
        self.git(root, "init")
        self.git(root, "add", ".")
        self.git(root, "-c", "user.name=Atlas", "-c", "user.email=atlas@example.test", "commit", "-m", "fixed")
        (root / "untracked.md").write_text("# untracked\n", encoding="utf-8")
        os.utime(root / "untracked.md", (1_700_000_123, 1_700_000_123))
        index = atlas_index.index_path(root)
        files = {item["path"]: item for item in index["files"]}
        self.assertEqual(set(files), {"tracked.md", "untracked.md"})
        self.assertEqual(files["tracked.md"]["timeSource"], "git")
        self.assertEqual(files["tracked.md"]["time"], "2020-01-02T03:04:05Z")
        self.assertEqual(files["untracked.md"]["timeSource"], "mtime")

    def test_config_cache_are_atomic_and_root_filter_does_not_replace_shared_cache(self) -> None:
        first = self.plain_root()
        second = self.base / "second"
        second.mkdir()
        (second / "README.md").write_text("# Second\n", encoding="utf-8")
        config_path = self.base / "xdg" / "config.json"
        cache_path = self.base / "xdg" / "index.json"
        config = atlas_index.add_root({"version": 1, "roots": []}, first, "first")
        config = atlas_index.add_root(config, second, "second")
        atlas_index.write_config(config, config_path)
        store = atlas_index.IndexStore(config_path, cache_path)
        full = store.rebuild()
        filtered = atlas_index.filter_index(full, "first")
        self.assertEqual([item["name"] for item in filtered["roots"]], ["first"])
        self.assertEqual([item["name"] for item in store.cached_or_rebuild()["roots"]], ["first", "second"])
        self.assertEqual(atlas_index.read_config(config_path), config)
        self.assertEqual(json.loads(cache_path.read_text(encoding="utf-8"))["summary"], full["summary"])
        self.assertEqual(list(cache_path.parent.glob(".index.json.*")), [])
        cache_path.write_text("not json", encoding="utf-8")
        diagnostics: list[str] = []
        rebuilt = store.cached_or_rebuild(diagnostics)
        self.assertEqual(rebuilt["summary"], full["summary"])
        self.assertEqual(len(diagnostics), 1)
        self.assertIn("cache corrupt", diagnostics[0])

    def test_invalid_config_is_not_replaced_and_ad_hoc_does_not_touch_xdg(self) -> None:
        config_path = self.base / "config" / "config.json"
        config_path.parent.mkdir(parents=True)
        config_path.write_text("{not json", encoding="utf-8")
        with self.assertRaisesRegex(atlas_index.IndexError, "cannot read config"):
            atlas_index.read_config(config_path)
        self.assertEqual(config_path.read_text(encoding="utf-8"), "{not json")
        root = self.plain_root()
        old_config, old_cache = os.environ.get("XDG_CONFIG_HOME"), os.environ.get("XDG_CACHE_HOME")
        isolated = self.base / "isolated"
        os.environ["XDG_CONFIG_HOME"] = str(isolated / "config")
        os.environ["XDG_CACHE_HOME"] = str(isolated / "cache")
        try:
            atlas_index.index_path(root)
        finally:
            if old_config is None:
                os.environ.pop("XDG_CONFIG_HOME", None)
            else:
                os.environ["XDG_CONFIG_HOME"] = old_config
            if old_cache is None:
                os.environ.pop("XDG_CACHE_HOME", None)
            else:
                os.environ["XDG_CACHE_HOME"] = old_cache
        self.assertFalse(isolated.exists())

    def git(self, root: Path, *args: str) -> None:
        environment = os.environ.copy()
        environment.update({"GIT_AUTHOR_DATE": "2020-01-02T03:04:05+00:00", "GIT_COMMITTER_DATE": "2020-01-02T03:04:05+00:00"})
        subprocess.run(["git", "-C", str(root), *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)


if __name__ == "__main__":
    unittest.main()
