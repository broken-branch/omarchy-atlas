#!/usr/bin/env python3
"""Write four small, fictional projects for Markdown Atlas demonstrations."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import time


PROJECTS = ("harbor-api", "lantern-ui", "ledger-cli", "field-notes")
TOPICS = (
    ("architecture", "storage", "access", "release", "testing", "signals", "recovery", "review"),
    ("component-guide", "state", "accessibility", "deployment", "checks", "events", "fallbacks", "handoff"),
    ("command-reference", "arguments", "permissions", "publishing", "validation", "output", "restore", "examples"),
    ("weekly-notes", "archive", "access", "planning", "validation", "updates", "follow-up", "decisions"),
)
AGES_HOURS = (0, 3, 0, 7, 11, 17, 22)
ACRONYMS = {"api", "ui", "cli", "adr", "http", "json"}


def title(name: str) -> str:
    return " ".join(word.upper() if word.lower() in ACRONYMS else word.capitalize()
                    for word in name.replace("-", " ").replace("_", " ").split())


def write(root: Path, relative: str, body: str, age_hours: int, now: int) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    stamp = now - age_hours * 3600
    os.utime(path, (stamp, stamp))


def project(root: Path, name: str, number: int, now: int, recent: list[int]) -> None:
    folder = root / name
    folder.mkdir()
    topics = TOPICS[number]
    files: list[str] = []
    files += [f"docs/adr/{i:04d}-{topics[i - 1]}.md" for i in range(1, 5)]
    files += [f"docs/guides/{topic}.md" for topic in topics]
    files += [f"runbooks/{topic}.md" for topic in topics[:4]]
    files += [f"packages/{topic}/README.md" for topic in topics[:3]]
    files += ["CHANGELOG.md"]
    section = "meetings" if name == "field-notes" else "notes"
    files += [f"{section}/{topic}-{i:02d}.md" for i in range(1, 4) for topic in topics]
    files += [f"docs/unlinked-{i}.md" for i in (1, 2)]
    hub = f"docs/guides/{topics[0]}.md"
    readme = (f"# {title(name)}\n\n"
              f"This project records the {topics[0]} workflow and its review steps.\n\n"
              "## Start here\n\n"
              f"- Read the [first decision]({files[0]}) for the initial boundary.\n"
              f"- Follow the [project guide]({hub}) before making a change.\n"
              "- Check the runbooks when a routine step fails.\n\n"
              "## Working sequence\n\n"
              "| Step | Record |\n| --- | --- |\n"
              "| Plan | Decision and guide |\n| Check | Runbook and review note |\n\n"
              f"```sh\n# Review the local guide before a change\ncat {hub}\n```\n\n"
              + ("[Request flow](docs/flows.mmd)\n\n"
                 "```mermaid\nflowchart LR\n  Request --> Route --> Store\n```\n\n" if number == 0 else "") +
              f"[Missing handoff](docs/missing-handoff.md)\n")
    write(folder, "README.md", readme, 60 + number * 8, now)

    for i, relative in enumerate(files):
        label = title(Path(relative).stem)
        age = 2 * 24 + ((len(files) - i) * 61 + number * 137) % (118 * 24)
        if relative == hub:
            age = 100 * 24
        if relative == "docs/guides/storage.md" and number == 0:
            age = 80 * 24
        if relative == "docs/guides/access.md" and number == 0:
            age = 75 * 24
        if recent and relative.endswith("-01.md"):
            age = recent.pop(0)
        body = (f"# {label}\n\n"
                f"{label} records the {topics[(i + number) % len(topics)]} work in {name}.\n\n")
        if not relative.startswith("docs/unlinked-"):
            next_file = files[i + 1] if i + 1 < len(files) - 2 else hub
            target = os.path.relpath(folder / next_file, (folder / relative).parent)
            body += f"[Next note]({target})\n\n"
            if relative != hub:
                body += f"See {os.path.relpath(folder / hub, (folder / relative).parent)} for the project guide.\n"
        if relative.startswith("docs/adr/"):
            body += "\nThe decision keeps the current interface small.\n"
        if name == "field-notes" and relative.startswith("meetings/"):
            other = PROJECTS[i % 3]
            other_hub = f"docs/guides/{TOPICS[PROJECTS.index(other)][0]}.md"
            target = os.path.relpath(root / other / other_hub, (folder / relative).parent)
            body += f"\nReview {target} with the project notes.\n"
        if relative == f"docs/guides/{topics[4]}.md":
            body += "\nSee [[CHANGELOG]] for the release checks.\n"
        if relative.startswith("docs/guides/"):
            body += ("\n## Scope\n\n"
                     f"Use this guide when reviewing {label.lower()} changes. Check the current decision and the next note before editing.\n\n"
                     "## Check\n\n"
                     "1. Identify the affected step.\n"
                     "2. Compare the guide with the current route.\n"
                     "3. Record the result in the review note.\n")
            if relative in {f"docs/guides/{topic}.md" for topic in topics[:4]}:
                body += ("\n## Handoff\n\n"
                         "| Item | Check |\n| --- | --- |\n"
                         "| Input | Confirm the expected source and owner. |\n"
                         "| Output | Confirm the result is recorded. |\n\n"
                         "Keep the decision, guide, and runbook in agreement before the handoff.\n")
        if relative.startswith("packages/") and relative.endswith("/README.md"):
            body += ("\n## Interface\n\nThe package accepts a local request and returns a recorded result.\n\n"
                     "## Review\n\n- Check the input.\n- Verify the result.\n- Record a failed step in the runbook.\n")
        write(folder, relative, body, age, now)

    instructions = {
        "AGENTS.md": f"# {title(name)} instructions\n\nRead {hub} before changes.\n",
        "CLAUDE.md": "# Claude instructions\n\n@AGENTS.md\n\nUse the project guide for context.\n",
        "GEMINI.md": "# Gemini instructions\n\n@AGENTS.md\n",
    }
    if number == 0:
        instructions.update({
            ".github/copilot-instructions.md": "# Copilot instructions\n\nReview docs/guides/architecture.md before changing the API.\n",
            ".cursor/rules/project.mdc": "---\nalwaysApply: true\n---\n\nUse the local project guide.\n",
            ".clinerules": "# Cline instructions\n\nCheck runbooks before changing a route.\n",
            ".claude/rules/style.md": "# Style rules\n\nKeep examples short.\n",
            ".claude/skills/review/SKILL.md": "# Review skill\n\nCheck the impact map.\n",
        })
    for relative, body in instructions.items():
        write(folder, relative, body, 25 * 24 + number, now)
    if number == 0:
        impact = {"rules": [
            {"source": ["src/router.py"], "docs": ["docs/guides/storage.md"]},
            {"source": ["src/store.py"], "docs": ["docs/guides/access.md"]},
        ]}
        write(folder, "docs/impact.yml", json.dumps(impact, indent=2) + "\n", 30 * 24, now)
        write(folder, "src/router.py", "# Route table for local requests.\n", 5 * 24, now)
        write(folder, "src/store.py", "# Record store for local requests.\n", 4 * 24, now)
        write(folder, "docs/flows.mmd", "flowchart LR\n  Request --> Route --> Store\n", 45 * 24, now)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--git", action="store_true", help="commit each generated project")
    parser.add_argument("--now", type=int, help="epoch seconds used for file times")
    args = parser.parse_args()
    root = args.out_dir.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    if any(root.iterdir()):
        parser.error("OUT-DIR must be empty")
    now = args.now if args.now is not None else int(time.time())
    for number, name in enumerate(PROJECTS):
        project(root, name, number, now, list(AGES_HOURS[2 * number:2 * number + 2]))
        if args.git:
            folder = root / name
            subprocess.run(["git", "init", "-q", str(folder)], check=True)
            subprocess.run(["git", "-C", str(folder), "add", "-A"], check=True)
            subprocess.run(["git", "-C", str(folder), "-c", "user.name=Demo Author",
                            "-c", "user.email=demo@example.com", "commit", "-qm", "Add demo project"],
                           check=True)


if __name__ == "__main__":
    main()
