#!/usr/bin/env python3
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

with open(os.environ["ATLAS_ARGV_LOG"], "a", encoding="utf-8") as output:
    output.write(json.dumps(sys.argv[1:], ensure_ascii=False) + "\n")

if stdio_log := os.environ.get("ATLAS_STDIO_LOG"):
    with open(stdio_log, "a", encoding="utf-8") as output:
        output.write(json.dumps({
            "stdoutPipe": stat.S_ISFIFO(os.fstat(sys.stdout.fileno()).st_mode),
            "stderrPipe": stat.S_ISFIFO(os.fstat(sys.stderr.fileno()).st_mode),
        }) + "\n")

if child_state := os.environ.get("ATLAS_LAUNCH_CHILD_STATE"):
    child = subprocess.Popen([
        sys.executable,
        "-c",
        "import pathlib,sys,time; time.sleep(0.6); pathlib.Path(sys.argv[1]).write_text('finished')",
        child_state,
    ])
    Path(child_state).write_text(str(child.pid), encoding="utf-8")

raise SystemExit(int(os.environ.get("ATLAS_LAUNCH_EXIT", "0")))
