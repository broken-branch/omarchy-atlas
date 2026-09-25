"""Instruction cost per agent, run through the CLI against fixture trees."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import atlas_index


PROJECT = Path(__file__).resolve().parents[1]
ATLAS = PROJECT / "atlas.py"
AGENTS_FIXTURE = Path(__file__).parent / "fixtures" / "cost" / "agents"


class CostTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.home = self.base / "home"
        self.home.mkdir()
        # A dot, an underscore and a space: Claude Code turns each into "-".
        self.root = self.base / "my_project v1.2"
        shutil.copytree(AGENTS_FIXTURE, self.root)
        self.env = {**os.environ, "HOME": str(self.home), "XDG_CONFIG_HOME": str(self.base / "config"),
                    "XDG_CACHE_HOME": str(self.base / "cache"), "PYTHONDONTWRITEBYTECODE": "1"}

    def write_home(self, relative: str, text: str) -> Path:
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def run_cli(self, *arguments: str, root: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, "-B", str(ATLAS), *arguments, "--path", str(root or self.root)],
                              cwd=PROJECT, env=self.env, text=True, capture_output=True, check=False, timeout=10)

    def cost(self, root: Path | None = None) -> dict[str, dict]:
        result = self.run_cli("cost", "--json", root=root)
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        return {row["agent"]: row for row in json.loads(result.stdout)["data"]["roots"]}

    def test_each_agent_row_separates_startup_from_referenced(self) -> None:
        personal = self.write_home(".claude/personal.md", "# Personal\n")
        claude = self.write_home(".claude/CLAUDE.md", "# Global\n@~/.claude/personal.md\n")
        codex = self.write_home(".codex/AGENTS.md", "# Codex\n")
        gemini = self.write_home(".gemini/GEMINI.md", "# Gemini\n")
        rows = self.cost()

        # Reordering BUILTIN_AGENTS reorders these keys.
        self.assertEqual(list(rows), ["claude", "codex", "gemini", "copilot", "cursor", "windsurf", "cline"])
        startup = {agent: [item["path"] for item in row["startup"]] for agent, row in rows.items()}
        referenced = {agent: [item["path"] for item in row["referenced"]] for agent, row in rows.items()}
        # Matching .claude/rules/*.md drops frontend/react.md; ignoring paths: puts
        # rules/ts.md at startup; ignoring applyTo puts py.instructions.md at startup;
        # reading frontmatter without skipping a byte order mark sends bom.mdc to referenced.
        self.assertEqual(startup, {
            # Entry points, then global files, then imports in the order they are met.
            "claude": [".claude/CLAUDE.md", ".claude/rules/frontend/react.md", ".claude/rules/style.md",
                       "CLAUDE.local.md", "CLAUDE.md", str(claude), "AGENTS.md", "docs/shared.md",
                       str(personal), "docs/nested.md"],
            "codex": ["AGENTS.md", str(codex)],
            "gemini": ["GEMINI.md", str(gemini), "AGENTS.md"],
            "copilot": [".github/copilot-instructions.md"],
            "cursor": [".cursor/rules/always.mdc", ".cursor/rules/bom.mdc", ".cursorrules"],
            "windsurf": [".windsurf/rules/rule.md", ".windsurfrules"],
            "cline": [".clinerules/rule.md"],
        })
        self.assertEqual(referenced, {
            # What startup files mention, nested instruction files, skill, agent and
            # command bodies, and rules scoped to some files.
            "claude": ["docs/guide.md", ".claude/agents/helper.md", ".claude/commands/ship.md",
                       ".claude/rules/ts.md", ".claude/skills/review/SKILL.md", "sub/CLAUDE.md"],
            "codex": ["docs/guide.md", "sub/AGENTS.md"],
            "gemini": ["docs/guide.md"],
            "copilot": [".github/instructions/py.instructions.md"],
            "cursor": [".cursor/rules/scoped.mdc"], "windsurf": [], "cline": [],
        })
        # AGENTS.md is 47 bytes, the global file 8; the guide 8 and sub/AGENTS.md 13.
        self.assertEqual({key: rows["codex"][key] for key in ("startupBytes", "startupTokensApprox",
                                                              "referencedBytes", "referencedTokensApprox")},
                         {"startupBytes": 55, "startupTokensApprox": 14,
                          "referencedBytes": 21, "referencedTokensApprox": 6})
        self.assertNotIn("totalTokensApprox", rows["codex"])

    def test_a_row_needs_a_startup_file_from_the_root_or_home(self) -> None:
        bare = self.base / "bare"
        (bare / "sub").mkdir(parents=True)
        (bare / "sub" / "GEMINI.md").write_text("# Nested Gemini\n", encoding="utf-8")
        codex = self.write_home(".codex/AGENTS.md", "# Codex\n")

        rows = self.cost(bare)

        # Keeping a row that has only referenced files adds gemini with an empty startup.
        self.assertEqual({agent: ([item["path"] for item in row["startup"]],
                                  [item["path"] for item in row["referenced"]]) for agent, row in rows.items()},
                         {"codex": ([str(codex)], [])})

    def test_text_lists_the_startup_total_then_the_largest_startup_files(self) -> None:
        result = self.run_cli("cost")

        # Sorting by path instead of size puts .claude/CLAUDE.md first.
        self.assertEqual(result.stdout.splitlines()[:9], [
            "my_project v1.2\tclaude\t~75 tokens approximate at startup\t292 bytes\t~43 referenced",
            "\t~35\tCLAUDE.md",
            "\t~12\tAGENTS.md",
            "\t~8\t.claude/CLAUDE.md",
            "\t~5\tdocs/nested.md",
            "\t~5\tdocs/shared.md",
            "\t~4\t.claude/rules/frontend/react.md",
            "\t~4\t.claude/rules/style.md",
            "\t~2\tCLAUDE.local.md",
        ])

    def test_imports_resolve_relative_recursive_and_dangle_when_missing(self) -> None:
        # Each of these exists, so only the rule under test keeps it out.
        for name in ("example", "fenced"):
            (self.root / "docs" / f"{name}.md").write_text(f"# {name}\n", encoding="utf-8")
        home_notes = self.write_home("home-notes.md", "# Home notes\n")
        (self.base / "outside.md").write_text("# Outside\n", encoding="utf-8")
        (self.root / "package.json").write_text("{}\n", encoding="utf-8")
        with (self.root / "CLAUDE.md").open("a", encoding="utf-8") as claude:
            claude.write("Ask @alice.smith; @package.json exists but is not indexed.\n"
                         "@~/home-notes.md is in HOME.\n"
                         "@../outside.md is outside every root and HOME.\n"
                         "Not an import: (@docs/guide.md).\n")
        rows = self.cost()

        # Dropping the code-span mask in import_tokens adds docs/example.md, the
        # fence check docs/fenced.md, the (?<!\S) lookbehind docs/guide.md, and
        # following imports outside the roots and HOME the outside.md above them.
        self.assertEqual([item["path"] for item in rows["claude"]["startup"]], [
            ".claude/CLAUDE.md", ".claude/rules/frontend/react.md", ".claude/rules/style.md",
            "CLAUDE.local.md", "CLAUDE.md", "AGENTS.md", "docs/shared.md", "package.json",
            str(home_notes), "docs/nested.md",
        ])
        dangling = self.run_cli("dangling")
        # Dropping the existing-file rule makes @~/home-notes.md and @../outside.md
        # dangle; dropping the document-suffix rule adds @alice.smith.
        self.assertEqual((dangling.returncode, dangling.stdout),
                         (1, "my_project v1.2:CLAUDE.md:5\t@docs/missing.md\n"))
        result = self.run_cli("index", "--json")
        references = json.loads(result.stdout)["data"]["index"]["references"]
        # An import's path is not also a path reference: dropping consumed.append
        # for imports adds path rows on lines 2 and 3. Code still names paths.
        self.assertEqual([(item["line"], item["style"], item["text"], item["to"] and item["to"]["path"])
                          for item in references if item["from"]["path"] == "CLAUDE.md"], [
            (2, "import", "@AGENTS.md", "AGENTS.md"),
            (3, "import", "@docs/shared.md", "docs/shared.md"),
            (4, "path", "docs/example.md", "docs/example.md"),
            (5, "import", "@docs/missing.md", None),
            (8, "path", "docs/fenced.md", "docs/fenced.md"),
            (13, "path", "docs/guide.md", "docs/guide.md"),
        ])
        self.assertEqual([(item["from"]["path"], item["text"]) for item in references
                          if item["style"] == "import" and item["from"]["path"] != "CLAUDE.md"],
                         [(".claude/CLAUDE.md", "@../AGENTS.md"), ("GEMINI.md", "@AGENTS.md")])

    def test_codex_counts_an_import_as_referenced_not_startup(self) -> None:
        (self.root / "docs" / "imported.md").write_text("# Imported\n", encoding="utf-8")
        with (self.root / "AGENTS.md").open("a", encoding="utf-8") as agents:
            agents.write("@docs/imported.md\n")
        rows = self.cost()

        # Setting codex's imports flag moves docs/imported.md into its startup.
        self.assertEqual(([item["path"] for item in rows["codex"]["startup"]],
                          [item["path"] for item in rows["codex"]["referenced"]]),
                         (["AGENTS.md"], ["docs/guide.md", "docs/imported.md", "sub/AGENTS.md"]))
        self.assertIn("docs/imported.md", [item["path"] for item in rows["claude"]["startup"]])

    def test_an_import_is_never_followed_to_a_credential_shaped_file(self) -> None:
        (self.root / "notes.env").write_text("TOKEN=secret\n", encoding="utf-8")
        (self.root / "docs" / "leak.md").symlink_to("../notes.env")
        (self.root / "key.env").symlink_to("docs/guide.md")
        with (self.root / "CLAUDE.md").open("a", encoding="utf-8") as claude:
            claude.write("@docs/leak.md @key.env\n")
        rows = self.cost()

        # Checking only the listed name follows docs/leak.md to notes.env; checking
        # only the resolved name follows key.env, which counts docs/guide.md at startup.
        startup = [item["path"] for item in rows["claude"]["startup"]]
        self.assertNotIn("docs/leak.md", startup)
        self.assertNotIn("docs/guide.md", startup)
        self.assertEqual(startup[-1], "docs/nested.md")

    def test_imports_stop_five_hops_from_the_entry_point(self) -> None:
        for hop in range(1, 7):
            (self.root / "docs" / f"hop{hop}.md").write_text(f"# Hop {hop}\n@hop{hop + 1}.md\n",
                                                             encoding="utf-8")
        with (self.root / "CLAUDE.md").open("a", encoding="utf-8") as claude:
            claude.write("@docs/hop1.md\n")
        rows = self.cost()

        # Without the limit hop6 is loaded at startup; stopping at four hops drops hop5.
        # hop5 names hop6.md, so a session may still load it later.
        self.assertEqual([item["path"] for item in rows["claude"]["startup"] if "hop" in item["path"]],
                         [f"docs/hop{hop}.md" for hop in range(1, 6)])
        self.assertIn("docs/hop6.md", [item["path"] for item in rows["claude"]["referenced"]])

    def test_an_import_above_2_mb_is_sized_from_stat_and_not_read(self) -> None:
        (self.root / "docs" / "extra.md").write_text("# Extra\n", encoding="utf-8")
        big = self.root / "notes" / "big.txt"
        big.write_text("[extra](../docs/extra.md)\n" + "x" * atlas_index.MAX_FILE_BYTES, encoding="utf-8")
        with (self.root / "CLAUDE.md").open("a", encoding="utf-8") as claude:
            claude.write("@notes/big.txt\n")
        rows = self.cost()

        entry = next(item for item in rows["claude"]["startup"] if item["path"] == "notes/big.txt")
        size = big.stat().st_size
        # Dropping the size check in _cost_file sizes it from the empty read.
        self.assertEqual((entry["bytes"], entry["lines"], entry["tokensApprox"]), (size, 0, math.ceil(size / 4)))
        # Reading the import again, whole, for its references lists docs/extra.md.
        self.assertNotIn("docs/extra.md", [item["path"] for item in rows["claude"]["referenced"]])

    def test_memory_path_replaces_every_non_alphanumeric_character_and_counts_200_lines(self) -> None:
        mangled = str(self.root)
        for character in "/._ ":
            mangled = mangled.replace(character, "-")
        memory = self.write_home(f".claude/projects/{mangled}/memory/MEMORY.md",
                                 "".join(f"line {number:03}\n" for number in range(1, 251)))
        rows = self.cost()
        entry = next(item for item in rows["claude"]["startup"] if item["path"] == str(memory))

        # Replacing only "/" misses this file; dropping the line limit counts all 250 lines.
        self.assertEqual((entry["lines"], entry["bytes"], entry["tokensApprox"]), (200, 1800, 450))

    def test_cline_rules_can_be_a_single_file(self) -> None:
        shutil.rmtree(self.root / ".clinerules")
        (self.root / ".clinerules").write_text("Cline rules in one file.\n", encoding="utf-8")

        self.assertEqual([item["path"] for item in self.cost()["cline"]["startup"]], [".clinerules"])

    def test_every_vendor_file_is_an_instruction_and_only_a_root_conventions_is_exempt(self) -> None:
        result = self.run_cli("files", "--json")
        kinds = {item["path"]: item["kind"] for item in json.loads(result.stdout)["data"]["files"]}

        # Dropping CONVENTIONS.md from the instruction kind makes it a doc and an orphan;
        # matching it at any depth exempts notes/CONVENTIONS.md, and orphans exits 0.
        self.assertEqual((kinds["CONVENTIONS.md"], kinds["notes/CONVENTIONS.md"]), ("instruction", "doc"))
        orphans = self.run_cli("orphans")
        self.assertEqual((orphans.returncode, orphans.stdout), (1, "orphan\tmy_project v1.2:notes/CONVENTIONS.md\n"))
        self.assertEqual(sorted(path for path, kind in kinds.items() if kind == "instruction"), [
            ".claude/CLAUDE.md", ".claude/agents/helper.md", ".claude/commands/ship.md",
            ".claude/rules/frontend/react.md", ".claude/rules/style.md", ".claude/rules/ts.md",
            ".claude/skills/review/SKILL.md", ".clinerules/rule.md",
            ".cursor/rules/always.mdc", ".cursor/rules/bom.mdc", ".cursor/rules/scoped.mdc", ".cursorrules",
            ".github/copilot-instructions.md", ".github/instructions/py.instructions.md",
            ".windsurf/rules/rule.md", ".windsurfrules", "AGENTS.md", "CLAUDE.local.md", "CLAUDE.md",
            "CONVENTIONS.md", "GEMINI.md", "sub/AGENTS.md", "sub/CLAUDE.md",
        ])
        # A hidden directory opens only for the paths the kind names.
        self.assertNotIn(".github/workflows/notes.md", kinds)

if __name__ == "__main__":
    unittest.main()
