import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "reader" / "vendor"

PINS = {
    "markdown-it.min.js": (
        "markdown-it 15.0.2",
        "https://cdn.jsdelivr.net/npm/markdown-it@15.0.2/dist/browser/markdown-it.umd.min.js",
        "MIT",
    ),
    "highlight.min.js": (
        "highlight.js 11.12.0",
        "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/highlight.min.js",
        "BSD-3-Clause",
    ),
    "force-graph.min.js": (
        "force-graph 1.51.4",
        "https://cdn.jsdelivr.net/npm/force-graph@1.51.4/dist/force-graph.min.js",
        "MIT",
    ),
}

LICENSES = {
    "LICENSE.markdown-it": "Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin.",
    "LICENSE.highlight.js": "BSD 3-Clause License",
    "LICENSE.force-graph": "MIT License",
}


def versions_file():
    comments = []
    checksums = {}
    for line in (VENDOR / "VERSIONS").read_text(encoding="utf-8").splitlines():
        if line.startswith("#"):
            comments.append(line)
        elif line:
            digest, filename = line.split("  ", 1)
            checksums[filename] = digest
    return "\n".join(comments), checksums


class VendorTests(unittest.TestCase):
    def test_exact_pins_licenses_and_checksums(self):
        comments, checksums = versions_file()
        expected_files = set(PINS) | set(LICENSES)
        self.assertEqual(set(checksums), expected_files)
        self.assertEqual(
            {path.name for path in VENDOR.iterdir()},
            expected_files | {"VERSIONS", "NOTICE"},
        )

        for filename, (version, url, license_name) in PINS.items():
            self.assertIn(f"# {version} {url} ({license_name})", comments)
            self.assertIn(url, (ROOT / "scripts/vendor-update").read_text(encoding="utf-8"))
        for filename, notice in LICENSES.items():
            self.assertIn(notice, (VENDOR / filename).read_text(encoding="utf-8"))
        for filename, expected in checksums.items():
            actual = hashlib.sha256((VENDOR / filename).read_bytes()).hexdigest()
            self.assertEqual(actual, expected, filename)

    @unittest.skipUnless(shutil.which("node"), "Node is unavailable for distribution-global checks")
    def test_browser_distributions_publish_expected_globals(self):
        probe = textwrap.dedent(
            """
            const fs = require('fs');
            const vm = require('vm');
            const [directory] = process.argv.slice(1);
            const distributions = [
              ['markdown-it.min.js', 'markdownit', 'function'],
              ['highlight.min.js', 'hljs', 'object'],
              ['force-graph.min.js', 'ForceGraph', 'function'],
            ];
            for (const [filename, globalName, expectedType] of distributions) {
              const sandbox = {
                console, setTimeout, clearTimeout, setInterval, clearInterval, performance,
                atob: value => Buffer.from(value, 'base64').toString('binary'),
                btoa: value => Buffer.from(value, 'binary').toString('base64'),
              };
              sandbox.globalThis = sandbox;
              sandbox.self = sandbox;
              sandbox.window = sandbox;
              vm.runInNewContext(fs.readFileSync(directory + '/' + filename, 'utf8'), sandbox, {
                filename, timeout: 10000,
              });
              if (typeof sandbox[globalName] !== expectedType) {
                throw new Error(filename + ' did not publish ' + globalName);
              }
            }
            """
        )
        subprocess.run(
            ["node", "-e", probe, str(VENDOR)],
            check=True,
            text=True,
            capture_output=True,
        )

    def test_gate_rejects_a_missing_asset(self):
        root = self.make_gate_fixture()
        (root / "reader/vendor/markdown-it.min.js").unlink()
        result = self.run_fixture_gate(root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("reader/vendor does not match VERSIONS", result.stderr)

    def test_gate_rejects_a_modified_asset(self):
        root = self.make_gate_fixture()
        with (root / "reader/vendor/markdown-it.min.js").open("ab") as asset:
            asset.write(b"modified")
        result = self.run_fixture_gate(root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("reader/vendor does not match VERSIONS", result.stderr)

    def make_gate_fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "scripts").mkdir()
        shutil.copy2(ROOT / "scripts/check", root / "scripts/check")
        shutil.copytree(VENDOR, root / "reader/vendor")
        (root / "README.md").touch()
        (root / "CONTRIBUTING.md").touch()
        for filename in ("index.md", "stack.md", "features.md", "contract.md"):
            path = root / "docs" / filename
            path.parent.mkdir(exist_ok=True)
            path.touch()
        return root

    @staticmethod
    def run_fixture_gate(root):
        environment = os.environ.copy()
        environment.pop("CI", None)
        return subprocess.run(
            ["sh", "scripts/check"],
            cwd=root,
            env=environment,
            text=True,
            capture_output=True,
        )


if __name__ == "__main__":
    unittest.main()
