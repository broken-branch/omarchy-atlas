"""Fixture process restart used by the desktop bootstrap probe."""

import http.client
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import tempfile
import time
import unittest

import atlas_auth
import atlas_index


PROBE = Path(__file__).resolve().parents[1] / "scripts/probe-browser-bootstrap"
probe = runpy.run_path(str(PROBE))


class ProbeProcessTest(unittest.TestCase):
    def test_new_process_reuses_port_and_delivers_queued_target_to_sse(self):
        with tempfile.TemporaryDirectory(prefix="atlas-probe-process-") as temporary:
            base = Path(temporary)
            root = base / "root"
            root.mkdir()
            (root / "NEXT.md").write_text("# Next\n", encoding="utf-8")
            config = base / "config/omarchy-atlas/config.json"
            atlas_index.write_config(atlas_index.add_root({"version": 1, "roots": []}, root, "fixture"), config)
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            receipt = base / "receipt.json"
            env = {**os.environ, "HOME": str(base), "XDG_CONFIG_HOME": str(base / "config"),
                   "XDG_CACHE_HOME": str(base / "cache"), "ATLAS_PROBE_PORT": str(port),
                   "ATLAS_PROBE_RECEIPT": str(receipt)}
            children = []
            def start(target=None):
                child = subprocess.Popen([sys.executable, "-B", str(PROBE), "--serve-fixture"],
                                         env={**env, "ATLAS_PROBE_QUEUED_SHOW": json.dumps(target)},
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                children.append(child)
                probe["wait_for"](lambda: probe["status"](port) == 200 or child.poll() is not None,
                                  "fixture process did not start", 5)
                self.assertIsNone(child.poll())
                return child
            try:
                first = start()
                credential = atlas_auth.server_secret(atlas_auth.secret_path(config))
                first_pid = first.pid
                first.terminate()
                first.wait(timeout=5)
                probe["wait_for"](lambda: probe["status"](port) is None, "old socket stayed open", 3)
                target = {"root": "fixture", "path": "NEXT.md", "view": "read"}
                second = start(target)
                self.assertNotEqual(first_pid, second.pid)
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                try:
                    token = atlas_auth.browser_token(credential, port)
                    connection.request("GET", "/api/events", headers={"Authorization": "Bearer " + token})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    lines = []
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        line = response.fp.readline().decode("utf-8")
                        lines.append(line)
                        if line == "\n" and any(item.startswith("event: show") for item in lines):
                            break
                    self.assertIn("event: show\n", lines)
                    self.assertIn("data: " + json.dumps(target, separators=(",", ":")) + "\n", lines)
                    probe["wait_for"](receipt.exists, "queued receipt missing", 3)
                    self.assertEqual(json.loads(receipt.read_text()), {"pid": second.pid, "target": target})
                finally:
                    connection.close()
            finally:
                for child in children:
                    if child.poll() is None:
                        child.terminate()
                        child.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
