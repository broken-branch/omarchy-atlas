#!/usr/bin/env python3
"""Offline assembly probe: print fixture index metrics without desktop state."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests" / "fixtures" / "index" / "plain"


def main() -> int:
    completed = subprocess.run(
        [sys.executable, "-B", str(ROOT / "atlas.py"), "index", "--path", str(FIXTURE), "--json"],
        check=True,
        capture_output=True,
        text=True,
    )
    reply = json.loads(completed.stdout)
    index = reply["data"]["index"]
    print(json.dumps({
        "probe": "fixture-index",
        "files": len(index["files"]),
        "references": len(index["references"]),
        "orphans": index["summary"]["orphans"],
        "dangling": index["summary"]["dangling"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
