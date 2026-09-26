"""The public demo exercises Markdown Atlas through its ad-hoc CLI root."""

from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
GENERATOR = REPO / "scripts" / "demo-workspace.py"
ATLAS = REPO / "atlas.py"
PROJECTS = ("harbor-api", "lantern-ui", "ledger-cli", "field-notes")
NOW = 1_784_000_000


class DemoWorkspaceTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.env = {**os.environ, "HOME": str(self.home),
                    "XDG_CONFIG_HOME": str(self.base / "config"),
                    "XDG_CACHE_HOME": str(self.base / "cache"),
                    "PYTHONDONTWRITEBYTECODE": "1"}

    def generate(self, output: Path, *options: str) -> None:
        result = subprocess.run([sys.executable, "-B", str(GENERATOR), str(output), "--now", str(NOW), *options],
                                cwd=REPO, env=self.env, text=True, capture_output=True, timeout=15)
        self.assertEqual((result.returncode, result.stderr), (0, ""))

    def cli_args(self, *arguments: str) -> dict:
        result = subprocess.run([sys.executable, "-B", str(ATLAS), *arguments, "--json"],
                                cwd=REPO, env=self.env, text=True, capture_output=True, timeout=15)
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        reply = json.loads(result.stdout)
        self.assertTrue(reply["ok"], reply)
        return reply["data"]

    def cli(self, command: str, root: Path) -> dict:
        return self.cli_args(command, "--path", str(root))

    def test_project_roots_have_expected_findings_reference_styles_and_agent_cost(self) -> None:
        workspace = self.base / "demo"
        self.generate(workspace)
        summaries = [self.cli("index", workspace / name)["index"]["summary"] for name in PROJECTS]
        self.assertTrue(180 <= sum(row["files"] for row in summaries) <= 250)
        self.assertEqual(sum(row["orphans"] for row in summaries), 8)
        self.assertEqual(sum(row["dangling"] for row in summaries), 4)
        self.assertGreaterEqual(sum(row["stale"] for row in summaries), 2)

        harbor = workspace / "harbor-api"
        index = self.cli("index", harbor)["index"]
        styles = {ref["style"] for ref in index["references"]}
        self.assertTrue({"markdown", "wikilink", "path", "import", "impact"} <= styles)
        self.assertEqual({row["path"] for row in self.cli("stale", harbor)["stale"]},
                         {"docs/guides/storage.md", "docs/guides/access.md"})
        self.assertEqual({row["agent"] for row in self.cli("cost", harbor)["roots"]},
                         {"claude", "codex", "gemini", "copilot", "cursor", "cline"})
        self.assertEqual(len(self.cli("dangling", harbor)["dangling"]), 1)
        self.assertEqual({row["path"] for row in self.cli("orphans", harbor)["orphans"]},
                         {"docs/unlinked-1.md", "docs/unlinked-2.md"})

        # The documented four-root setup resolves meeting references across roots.
        for name in PROJECTS:
            self.cli_args("root-add", str(workspace / name))
        registered = self.cli_args("index")["index"]
        meeting_links = [ref for ref in registered["references"]
                         if ref["style"] == "path" and ref["from"]["root"] == "field-notes"
                         and ref["from"]["path"].startswith("meetings/") and ref["to"]
                         and ref["to"]["root"] != "field-notes"]
        self.assertEqual(len(meeting_links), 24)
        self.assertEqual({ref["to"]["root"] for ref in meeting_links}, set(PROJECTS[:3]))
        pairs = {(ref["from"]["root"], ref["from"]["path"],
                  ref["to"]["root"], ref["to"]["path"]) for ref in meeting_links}
        self.assertIn(("field-notes", "meetings/access-01.md", "lantern-ui",
                       "docs/guides/component-guide.md"), pairs)
        self.assertIn(("field-notes", "meetings/access-02.md", "harbor-api",
                       "docs/guides/architecture.md"), pairs)
        self.assertIn(("field-notes", "meetings/access-03.md", "ledger-cli",
                       "docs/guides/command-reference.md"), pairs)

        # The same relative paths also resolve when the parent is one root.
        whole = self.cli("index", workspace)["index"]
        whole_pairs = {(ref["from"]["path"], ref["to"]["path"])
                       for ref in whole["references"] if ref["to"]}
        self.assertIn(("field-notes/meetings/access-01.md",
                       "lantern-ui/docs/guides/component-guide.md"), whole_pairs)
        self.assertIn(("field-notes/meetings/access-01.md",
                       "field-notes/docs/guides/weekly-notes.md"), whole_pairs)
        self.assertTrue(any(ref["from"] == {"root": "field-notes", "path": "README.md"}
                            and ref["to"] is None and "missing-handoff.md" in ref["text"]
                            for ref in registered["references"]))

    def test_recent_files_and_repeated_runs_have_same_content_and_relative_mtimes(self) -> None:
        first, second = self.base / "first", self.base / "second"
        self.generate(first)
        self.generate(second)

        def contents_and_ages(root: Path) -> tuple[dict[str, bytes], dict[str, int]]:
            paths = sorted(path for path in root.rglob("*") if path.is_file())
            anchor = max(path.stat().st_mtime_ns for path in paths)
            return ({str(path.relative_to(root)): path.read_bytes() for path in paths},
                    {str(path.relative_to(root)): (anchor - path.stat().st_mtime_ns) // 1_000_000_000
                     for path in paths})

        contents1, ages1 = contents_and_ages(first)
        contents2, ages2 = contents_and_ages(second)
        self.assertEqual(contents1, contents2)
        self.assertEqual(ages1, ages2)
        self.assertEqual(len(contents1), 209)
        readme = contents1["harbor-api/README.md"].decode()
        self.assertIn("# Harbor API", readme)
        self.assertIn("```mermaid", readme)
        self.assertIn("| Step | Record |", readme)
        self.assertIn("```sh", readme)
        self.assertIn("# Lantern UI", contents1["lantern-ui/README.md"].decode())
        self.assertIn("# Ledger CLI", contents1["ledger-cli/README.md"].decode())
        hubs = ("architecture", "component-guide", "command-reference", "weekly-notes")
        for name, hub in zip(PROJECTS, hubs):
            self.assertIn("## Handoff", contents1[f"{name}/docs/guides/{hub}.md"].decode())
            self.assertIn(f"docs/guides/{hub}.md", contents1[f"{name}/README.md"].decode())
        guide_names = {name: {path.rsplit("/", 1)[-1] for path in contents1
                              if path.startswith(f"{name}/docs/guides/")} for name in PROJECTS}
        self.assertEqual(len(set.union(*guide_names.values())), 30)

        # Markdown Atlas's modified time is the contract's source for map recency.
        files = [row for name in PROJECTS for row in self.cli("files", first / name)["files"]]
        ages = [NOW - dt.datetime.fromisoformat(row["modified"]).timestamp() for row in files]
        self.assertTrue(all(age >= 0 for age in ages))
        self.assertEqual(sum(age < 30 * 60 for age in ages), 2)
        self.assertEqual(sum(30 * 60 <= age < 24 * 3600 for age in ages), 5)
        self.assertTrue(any(age >= 100 * 24 * 3600 for age in ages))
        self.assertTrue(all(age <= 120 * 24 * 3600 for age in ages))

    def test_git_option_commits_each_project(self) -> None:
        workspace = self.base / "git-demo"
        self.generate(workspace, "--git")
        for name in PROJECTS:
            result = subprocess.run(["git", "-C", str(workspace / name), "rev-list", "--count", "HEAD"],
                                    text=True, capture_output=True, timeout=5)
            self.assertEqual((result.returncode, result.stdout.strip()), (0, "1"))


if __name__ == "__main__":
    unittest.main()
