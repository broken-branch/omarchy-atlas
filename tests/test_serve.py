"""HTTP and refresh behaviour exercised against a real loopback server."""

from __future__ import annotations

import http.client
import html
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import socket
import re
import threading
import time
import unittest
from urllib.parse import urlencode
from unittest import mock

import atlas_index
import atlas_auth
import atlas_serve


FIXTURE = Path(__file__).parent / "fixtures" / "serve"


class ServeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "root"
        shutil.copytree(FIXTURE / "root", self.root)
        (self.root / "env.fixture").rename(self.root / ".env")
        binary_fixture = self.root / "blob.bin.hex"
        (self.root / "blob.bin").write_bytes(bytes.fromhex(binary_fixture.read_text(encoding="ascii").strip()))
        binary_fixture.unlink()
        self.reader = self.base / "reader"
        shutil.copytree(FIXTURE / "reader", self.reader)
        self.theme = self.base / "theme"
        shutil.copytree(FIXTURE / "theme" / "dark", self.theme)
        # The CLI and atlas_analyze.cost read HOME and XDG; none of it is the runner's.
        self.home = self.base / "home"
        self.home.mkdir()
        environment = mock.patch.dict(os.environ, {
            "HOME": str(self.home), "XDG_CONFIG_HOME": str(self.home / ".config"),
            "XDG_CACHE_HOME": str(self.home / ".cache"), "ATLAS_LAUNCH_LOG": str(self.base / "launcher.json"),
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.config, self.cache = atlas_index.state_paths()
        config = atlas_index.add_root({"version": 1, "roots": []}, self.root, "demo")
        config["kinds"] = [{"id": "config", "label": "Configuration", "colour": "cyan",
                            "match": {"extensions": [".toml", ".bin"]}}]
        atlas_index.write_config(config, self.config)
        self.launch_log = self.base / "launcher.json"
        launcher = [sys.executable, str(FIXTURE / "record_launcher.py")]
        self.server = atlas_serve.create_server(
            port=0, config_path=self.config, cache_path=self.cache, reader_dir=self.reader,
            theme_dir=self.theme, shell_override_path=self.base / "absent-override.toml",
            editor_launcher=launcher, refresh_interval=0.05,
            rounding_command=None,
        )
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    @property
    def port(self) -> int:
        return self.server.server_address[1]

    def request(self, method: str, path: str, body: object | None = None, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body).encode("utf-8")
        request_headers = dict(headers or {})
        request_headers.setdefault("Authorization", "Bearer " + self.server.state.secret.hex())
        if encoded is not None:
            request_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, encoded, request_headers)
        response = connection.getresponse()
        result = (response.status, {key.lower(): value for key, value in response.getheaders()}, response.read())
        connection.close()
        return result

    def event_client(self) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        self.addCleanup(connection.close)
        connection.request("GET", "/api/events", headers={"Authorization": "Bearer " + self.server.state.secret.hex()})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
        return connection, response

    def next_event(self, response: http.client.HTTPResponse, wanted: str) -> object:
        deadline = time.monotonic() + 3
        event = None
        while time.monotonic() < deadline:
            line = response.fp.readline().decode("utf-8").strip()
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: ") and event is not None:
                data = json.loads(line[6:])
                if event == wanted:
                    return data
                event = None
        self.fail(f"did not receive {wanted} event")

    def bootstrap_request(self, fields: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        body = urlencode(fields)
        connection.request("POST", "/auth/bootstrap", body,
                           {"Content-Type": "application/x-www-form-urlencoded", "Origin": "null",
                            "Sec-Fetch-Site": "cross-site"})
        response = connection.getresponse()
        result = (response.status, {key.lower(): value for key, value in response.getheaders()}, response.read())
        connection.close()
        return result

    def test_auth_denies_every_route_before_state_or_actions(self) -> None:
        for path in ("/theme.css", "/api/index", "/api/file?root=demo&path=docs/guide.md",
                     "/raw/demo/docs/guide.md", "/api/events", "/missing"):
            status, headers, body = self.request("GET", path, headers={"Authorization": ""})
            self.assertEqual((path, status, headers["cache-control"]), (path, 401, "no-store"))
            self.assertNotIn(b"Guide", body)
        for path in ("/api/show", "/api/edit", "/missing"):
            self.assertEqual(self.request("POST", path, {"root": "demo", "path": "docs/guide.md"},
                                          headers={"Authorization": ""})[0], 401)
        self.assertIsNone(self.server.state.index)
        self.assertEqual(self.server.state.client_count(), 0)
        self.assertFalse(self.launch_log.exists())
        self.assertEqual(self.request("GET", "/api/index", headers={"Authorization": "Bearer invalid"})[0], 401)
        for path in ("/", "/read/demo/docs/guide.md", "/map", "/app.js"):
            status, _headers, body = self.request("GET", path, headers={"Authorization": "", "Cookie": "atlas_session=stolen"})
            self.assertEqual(status, 200)
            self.assertNotIn(b"Guide", body)

    def test_browser_bootstrap_port_scope_replay_expiry_and_csrf(self) -> None:
        target = "/read/demo/docs/guide.md"
        file = atlas_auth.bootstrap_file(self.cache, self.server.state.secret, target,
                                         f"http://127.0.0.1:{self.port}")
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        page = file.read_text(encoding="utf-8")
        fields = {key: html.unescape(value) for key, value in re.findall(r'name="([^"]+)" value="([^"]+)"', page)}
        status, headers, _body = self.bootstrap_request(fields)
        self.assertEqual(status, 200)
        token = atlas_auth.browser_token(self.server.state.secret, self.port)
        self.assertIn(token.encode(), _body)
        self.assertNotIn("set-cookie", headers)
        self.assertFalse(file.exists())
        self.assertEqual(self.bootstrap_request(fields)[0], 401)
        self.assertEqual(self.request("GET", "/api/index", headers={"Authorization": "", "Cookie": "atlas_session=stolen"})[0], 401)
        self.assertEqual(self.request("GET", "/raw/demo/docs/guide.md", headers={"Authorization": "", "Cookie": "atlas_session=stolen"})[0], 401)
        self.assertEqual(self.request("GET", "/api/index", headers={"Authorization": "Bearer " + token})[0], 200)
        body = {"root": "demo", "path": "docs/guide.md", "view": "read"}
        self.assertEqual(self.request("POST", "/api/show", body,
                                      headers={"Authorization": "", "Cookie": "atlas_session=stolen", "Origin": f"http://127.0.0.1:{self.port}"})[0], 401)
        self.assertEqual(self.request("POST", "/api/show", body,
                                      headers={"Authorization": "Bearer " + token})[0], 403)
        own = f"http://127.0.0.1:{self.port}"
        self.assertEqual(self.request("POST", "/api/show", body,
                                      headers={"Authorization": "Bearer " + token, "Origin": own})[0], 200)
        self.assertEqual(self.request("POST", "/api/show", body,
                                      headers={"Authorization": "Bearer " + token, "Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.bootstrap_request({**fields, "nonce": "bad"})[0], 401)
        expired = {**fields, "nonce": "a" * 48, "expires": str(int(time.time()) - 1)}
        expired["signature"] = atlas_auth.signature(self.server.state.secret, expired["nonce"], int(expired["expires"]), target)
        self.assertEqual(self.bootstrap_request(expired)[0], 401)
        other = atlas_serve.create_server(port=0, config_path=self.config, cache_path=self.cache,
                                           reader_dir=self.reader, theme_dir=self.theme, rounding_command=None)
        restart_token = atlas_auth.browser_token(other.state.secret, other.server_address[1])
        thread = threading.Thread(target=other.serve_forever)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", other.server_address[1], timeout=3)
            connection.request("GET", "/api/index", headers={"Authorization": "Bearer " + token})
            reply = connection.getresponse()
            self.assertEqual(reply.status, 401)
            reply.read(); connection.close()
        finally:
            other.shutdown(); other.server_close(); thread.join()
        restarted = atlas_serve.create_server(port=other.server_address[1], config_path=self.config, cache_path=self.cache,
                                               reader_dir=self.reader, theme_dir=self.theme, rounding_command=None)
        restarted_thread = threading.Thread(target=restarted.serve_forever)
        restarted_thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", restarted.server_address[1], timeout=3)
            connection.request("GET", "/api/index", headers={"Authorization": "Bearer " + restart_token})
            reply = connection.getresponse()
            self.assertEqual(reply.status, 200)
            reply.read(); connection.close()
        finally:
            restarted.shutdown(); restarted.server_close(); restarted_thread.join()

    def test_show_queued_before_reader_reconnect_is_delivered(self) -> None:
        body = {"root": "demo", "path": "docs/guide.md", "view": "read"}
        status, _headers, payload = self.request("POST", "/api/show", body)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload)["clients"], 0)
        connection, response = self.event_client()
        self.assertEqual(self.next_event(response, "show"), body)
        connection.close()

    def test_failed_rebuild_exposes_stale_index_and_recovery(self) -> None:
        status, _headers, body = self.request("GET", "/api/index")
        self.assertEqual(status, 200)
        generated = json.loads(body)["generatedAt"]
        _connection, stream = self.event_client()
        original = self.config.read_bytes()
        self.config.write_text("{invalid", encoding="utf-8")
        self.server.state.refresh_index(force=True)
        failure = self.next_event(stream, "index-error")
        self.assertEqual(failure["generatedAt"], generated)
        self.assertIn("config", failure["error"])
        status, _headers, body = self.request("GET", "/api/index")
        self.assertEqual(status, 503)
        self.assertIn(b"config", body)
        self.assertEqual(self.server.state.index["generatedAt"], generated)
        self.config.write_bytes(original)
        self.server.state.last_index_attempt = 0
        self.server.state.refresh_index()
        self.assertEqual(self.next_event(stream, "index"), {})
        self.assertEqual(self.request("GET", "/api/index")[0], 200)

    def wait_for(self, path: str, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            reply = self.request("GET", path)
            if predicate(reply):
                return reply
            time.sleep(0.01)
        self.fail(f"{path} did not reach the expected state")

    def test_routes_static_data_etags_and_containment(self) -> None:
        status, headers, body = self.request("GET", "/")
        self.assertEqual((status, headers["content-type"]), (200, "text/html; charset=utf-8"))

        self.assertIn(b"fixture reader", body)
        self.assertEqual(self.request("GET", "/vendor/fixture.js")[0], 200)
        self.assertEqual(self.request("GET", "/vendor/nested/fixture.js")[0], 404)

        status, _headers, body = self.request("GET", "/api/index")
        self.assertEqual(status, 200)
        index = json.loads(body)
        self.assertEqual(index["summary"]["files"], 4)
        # Removing kinds from the index response makes the browser invent its own table.
        self.assertEqual(index["kinds"][0]["id"], "config")
        status, headers, body = self.request("GET", "/api/file?root=demo&path=docs/guide.md")
        self.assertEqual(status, 200)
        document = json.loads(body)
        self.assertEqual(document["file"]["path"], "docs/guide.md")
        self.assertEqual(document["cost"], [])
        self.assertIn("path", {reference["style"] for reference in document["references"]["inbound"]})
        self.assertEqual(self.request("GET", "/api/file?root=demo&path=docs/guide.md", headers={"If-None-Match": headers["etag"]})[0], 304)

        status, headers, body = self.request("GET", "/raw/demo/docs/guide.md")
        self.assertEqual((status, headers["content-type"]), (200, "text/markdown; charset=utf-8"))
        self.assertIn(b"Guide", body)
        self.assertEqual(self.request("GET", "/raw/demo/docs/guide.md", headers={"If-None-Match": headers["etag"]})[0], 304)
        self.assertEqual(self.request("GET", "/raw/demo/settings.toml")[1]["content-type"], "application/toml; charset=utf-8")
        self.assertEqual(self.request("GET", "/raw/demo/.env")[0], 403)
        self.assertEqual(self.request("GET", "/raw/demo/docs/%2e%2e/AGENTS.md")[0], 403)

        outside = self.base / "outside.md"
        outside.write_text("outside", encoding="utf-8")
        (self.root / "docs" / "escape.md").symlink_to(outside)
        (self.root / "docs" / "guide-alias.md").symlink_to("guide.md")
        self.assertEqual(self.request("GET", "/raw/demo/docs/escape.md")[0], 403)
        status, _headers, body = self.request("GET", "/api/file?root=demo&path=docs/guide-alias.md")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["file"]["path"], "docs/guide.md")
        self.assertEqual(self.request("GET", "/read/demo/docs/guide-alias.md")[0], 200)
        self.assertEqual(self.request("GET", "/map/demo/docs/escape.md")[0], 200)

    def test_unchanged_refresh_reuses_index_and_requests_do_not_wait_for_rebuild(self) -> None:
        state = self.server.state
        original = state.get_index()
        cache_mtime = self.cache.stat().st_mtime_ns
        state.last_index_attempt = 0
        self.assertIs(state.refresh_index(), original)
        self.assertEqual(self.cache.stat().st_mtime_ns, cache_mtime)
        (self.root / "docs" / "guide.md").write_text("# Changed\n", encoding="utf-8")
        entered = threading.Event()
        release = threading.Event()
        rebuild = state.store.rebuild

        def delayed_rebuild():
            entered.set()
            self.assertTrue(release.wait(3))
            return rebuild()

        with mock.patch.object(state.store, "rebuild", side_effect=delayed_rebuild):
            worker = threading.Thread(target=lambda: state.refresh_index(force=True))
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                started = time.monotonic()
                status, _headers, body = self.request("GET", "/api/index")
                self.assertLess(time.monotonic() - started, 0.5)
                self.assertEqual((status, json.loads(body)["generatedAt"]), (200, original["generatedAt"]))
            finally:
                release.set()
                worker.join(3)
            self.assertFalse(worker.is_alive())
        guide = next(item for item in state.get_index()["files"] if item["path"] == "docs/guide.md")
        self.assertEqual(guide["title"], "Changed")

    def test_edit_during_rebuild_is_served_after_next_refresh(self) -> None:
        state = self.server.state
        state.get_index()
        guide = self.root / "docs" / "guide.md"
        guide.write_text("# First edit\n", encoding="utf-8")
        rebuild = state.store.rebuild

        def edit_after_build():
            candidate = rebuild()
            guide.write_text("# Second edit with more content\n", encoding="utf-8")
            return candidate

        with mock.patch.object(state.store, "rebuild", side_effect=edit_after_build):
            first = state.refresh_index(force=True)
        self.assertEqual(next(item["title"] for item in first["files"]
                              if item["path"] == "docs/guide.md"), "First edit")
        state.last_index_attempt = 0
        state.refresh_index()
        status, _headers, body = self.request("GET", "/api/index")
        self.assertEqual(status, 200)
        self.assertEqual(next(item["title"] for item in json.loads(body)["files"]
                              if item["path"] == "docs/guide.md"), "Second edit with more content")

    def test_rounding_is_read_only_when_theme_or_hypr_config_changes(self) -> None:
        state = self.server.state
        with mock.patch.object(state, "_rounding", return_value="5px") as rounding:
            state.refresh_theme(force=True)
            state.refresh_theme(force=True)
            self.assertEqual(rounding.call_count, 1)
            hypr = self.home / ".config/hypr"
            hypr.mkdir(parents=True)
            (hypr / "hyprland.conf").write_text("decoration {}\n", encoding="utf-8")
            state.refresh_theme(force=True)
            self.assertEqual(rounding.call_count, 2)

    def test_instruction_file_returns_only_its_own_cost_row_from_the_isolated_home(self) -> None:
        # A second agent row in the same root, fed by a global file in the
        # test's own HOME: the per-file filter must leave it out.
        (self.root / "CLAUDE.md").write_text("# Claude\n", encoding="utf-8")
        (self.home / ".claude").mkdir()
        (self.home / ".claude" / "CLAUDE.md").write_text("# Global\n", encoding="utf-8")
        cli = subprocess.run([sys.executable, "-B", str(Path(atlas_serve.__file__).with_name("atlas.py")), "cost", "--json"],
                             capture_output=True, text=True, check=True, timeout=10)
        expected = [row for row in json.loads(cli.stdout)["data"]["roots"] if row["agent"] == "codex"]
        self.assertEqual([row["agent"] for row in json.loads(cli.stdout)["data"]["roots"]], ["claude", "codex"])

        status, _headers, body = self.request("GET", "/api/file?root=demo&path=AGENTS.md")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["cost"], expected)
        status, _headers, body = self.request("GET", "/api/file?root=demo&path=CLAUDE.md")
        self.assertEqual([file["path"] for file in json.loads(body)["cost"][0]["startup"]],
                         ["CLAUDE.md", str(self.home / ".claude" / "CLAUDE.md")])

    @unittest.skipIf(os.geteuid() == 0, "root reads a file whatever its mode")
    def test_instruction_file_loads_without_cost_when_a_cost_input_cannot_be_read(self) -> None:
        unreadable = self.home / ".codex" / "AGENTS.md"
        unreadable.parent.mkdir()
        unreadable.write_text("# Global\n", encoding="utf-8")
        unreadable.chmod(0)
        self.addCleanup(unreadable.chmod, 0o644)
        status, _headers, body = self.request("GET", "/api/file?root=demo&path=AGENTS.md")
        document = json.loads(body)
        # Letting the cost error escape the route makes this a 404 without content.
        self.assertEqual((status, document["cost"]), (200, []))
        self.assertIn("content", document)

    def test_missing_root_leaves_the_other_roots_and_their_cost_served(self) -> None:
        other = self.base / "other"
        other.mkdir()
        (other / "AGENTS.md").write_text("# Other\n", encoding="utf-8")
        atlas_index.write_config(atlas_index.add_root(atlas_index.read_config(self.config), other, "other"), self.config)
        self.assertEqual(self.request("GET", "/api/index")[0], 200)
        shutil.rmtree(other)  # an unmounted drive, for instance
        status, _headers, body = self.wait_for(
            "/api/index", lambda reply: [item["name"] for item in json.loads(reply[2])["roots"]] == ["demo"])
        index = json.loads(body)
        # Restoring the invalid_root refusal for a gone root keeps "other" in this index.
        self.assertEqual((status, [root["name"] for root in index["roots"]]), (200, ["demo"]))
        self.assertIn({"root": "other", "reason": "root missing"}, index["unavailable"])
        status, _headers, body = self.request("GET", "/api/file?root=demo&path=AGENTS.md")
        self.assertEqual((status, [row["agent"] for row in json.loads(body)["cost"]]), (200, ["codex"]))
        self.assertEqual(self.request("GET", "/api/file?root=other&path=AGENTS.md")[0], 403)

    def test_host_other_than_atlas_loopback_is_refused(self) -> None:
        for host in ("attacker.example:%d" % self.port, "127.0.0.1:1", "127.0.0.1", "localhost.attacker.example:%d" % self.port):
            for path in ("/", "/api/index", "/api/file?root=demo&path=docs/guide.md", "/raw/demo/docs/guide.md", "/api/events"):
                status, _headers, body = self.request("GET", path, headers={"Host": host})
                self.assertEqual((host, path, status), (host, path, 403))
                self.assertNotIn(b"Guide", body)
            status, _headers, _body = self.request("POST", "/api/edit", {"root": "demo", "path": "docs/guide.md"}, headers={"Host": host})
            self.assertEqual(status, 403)
        self.assertFalse(self.launch_log.exists())
        self.assertEqual(self.request("GET", "/api/index", headers={"Host": "localhost:%d" % self.port})[0], 200)
        self.assertEqual(self.request("GET", "/api/index")[0], 200)

    def test_cross_site_post_is_refused_before_edit_or_show_acts(self) -> None:
        connection, events = self.event_client()
        own = "http://127.0.0.1:%d" % self.port
        refused = [
            ({"Content-Type": "text/plain"}, 415),
            ({"Content-Type": "application/x-www-form-urlencoded"}, 415),
            ({"Origin": "https://evil.example"}, 403),
            ({"Origin": "http://127.0.0.1:%d" % (self.port + 1)}, 403),
            ({"Origin": "null"}, 403),
            ({"Sec-Fetch-Site": "cross-site"}, 403),
            ({"Sec-Fetch-Site": "same-site"}, 403),
        ]
        for headers, expected in refused:
            for route, body in (("/api/edit", {"root": "demo", "path": "docs/guide.md"}),
                                ("/api/show", {"root": "demo", "path": "docs/guide.md", "view": "map"})):
                self.assertEqual((headers, route, self.request("POST", route, body, headers=headers)[0]), (headers, route, expected))
        self.assertFalse(self.launch_log.exists())
        status, _headers, body = self.request("POST", "/api/show", {"root": "demo", "path": "AGENTS.md", "view": "read"},
                                              headers={"Origin": own, "Sec-Fetch-Site": "same-origin",
                                                       "Content-Type": "application/json; charset=utf-8"})
        self.assertEqual((status, json.loads(body)), (200, {"clients": 1}))
        self.assertEqual(self.next_event(events, "show"), {"root": "demo", "path": "AGENTS.md", "view": "read"})
        status, _headers, _body = self.request("POST", "/api/edit", {"root": "demo", "path": "docs/guide.md"},
                                               headers={"Origin": "http://localhost:%d" % self.port})
        self.assertEqual(status, 200)
        connection.close()

    def test_raw_sandboxes_active_content_and_serves_only_images_and_indexed_files(self) -> None:
        (self.root / "docs" / "evil.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/index")</script></svg>', encoding="utf-8")
        (self.root / "secrets.yaml").write_text("api_key: sk-live-SECRET\n", encoding="utf-8")
        (self.root / ".hidden").mkdir()
        (self.root / ".hidden" / "hosts.yml").write_text("oauth_token: SECRET\n", encoding="utf-8")
        (self.root / "notes.txt").write_text("SECRET\n", encoding="utf-8")
        # Judging the requested name instead of the resolved file serves the YAML as an image.
        (self.root / "logo.png").symlink_to("secrets.yaml")
        status, headers, body = self.request("GET", "/raw/demo/docs/evil.svg")
        self.assertEqual((status, headers["content-type"]), (200, "image/svg+xml"))
        self.assertEqual(headers["content-security-policy"], atlas_serve.RAW_POLICY)
        self.assertTrue(headers["content-security-policy"].startswith("sandbox; default-src 'none';"))
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        status, headers, _body = self.request("GET", "/raw/demo/docs/guide.md")
        self.assertEqual((status, headers["content-security-policy"]), (200, atlas_serve.RAW_POLICY))
        for path in ("secrets.yaml", "logo.png", ".hidden/hosts.yml", "notes.txt", "docs/impact.yml"):
            status, headers, body = self.request("GET", "/raw/demo/" + path)
            self.assertEqual((path, status), (path, 404))
            self.assertNotIn(b"SECRET", body)
            self.assertEqual(headers["content-security-policy"], atlas_serve.RAW_POLICY)

    def test_symlink_to_a_credential_file_is_denied_on_every_route(self) -> None:
        (self.root / "leak.md").symlink_to(".env")
        (self.root / "docs" / "notes.md").symlink_to("../.env")
        for name in ("leak.md", "docs/notes.md"):
            for path in ("/api/file?root=demo&path=" + name, "/raw/demo/" + name):
                status, _headers, body = self.request("GET", path)
                self.assertEqual((path, status, json.loads(body).get("code")), (path, 403, "denied"))
                self.assertNotIn(b"DEMO_ONLY", body)
            status, _headers, body = self.request("POST", "/api/edit", {"root": "demo", "path": name})
            self.assertEqual((status, json.loads(body)["code"]), (403, "denied"))
        self.assertFalse(self.launch_log.exists())

    def test_oversized_file_is_refused_from_its_size_without_being_read(self) -> None:
        large = self.root / "docs" / "large.md"
        image = self.root / "docs" / "large.png"
        for path in (large, image):
            with path.open("wb") as handle:
                handle.truncate(atlas_serve.MAX_FILE_BYTES + 1)
        self.assertEqual(self.request("GET", "/api/index")[0], 200)
        self.server.state.interval = 3600
        # An unreadable file shows whether the server read it or only stat()ed it.
        large.chmod(0)
        image.chmod(0)
        self.addCleanup(large.chmod, 0o644)
        self.addCleanup(image.chmod, 0o644)
        for path in ("/api/file?root=demo&path=docs/large.md", "/raw/demo/docs/large.md", "/raw/demo/docs/large.png"):
            status, _headers, body = self.request("GET", path)
            self.assertEqual((path, status, json.loads(body)["error"]), (path, 413, "file exceeds 2 MB"))

    def test_refresh_fingerprints_a_file_above_the_cap_by_size_and_time(self) -> None:
        large = self.root / "docs" / "large.md"
        with large.open("wb") as handle:
            handle.truncate(atlas_serve.MAX_FILE_BYTES + 1)
        self.assertEqual(self.request("GET", "/api/index")[0], 200)
        _connection, events = self.event_client()

        os.utime(large, (1_600_000_000, 1_600_000_000))

        # The bytes are unchanged: hashing them, as below the cap, sends no file event.
        self.assertEqual(self.next_event(events, "file"), {"root": "demo", "path": "docs/large.md"})

    def test_sse_index_event_tracks_mtime_and_swap_without_body_changes(self) -> None:
        target = self.root / "docs/guide.md"
        self.assertEqual(self.request("GET", "/api/index")[0], 200)
        _connection, events = self.event_client()

        os.utime(target, ns=(1_700_000_123_456_789_000, 1_700_000_123_456_789_000))
        self.assertEqual(self.next_event(events, "index"), {})
        indexed = json.loads(self.request("GET", "/api/index")[2])
        guide = next(item for item in indexed["files"] if item["path"] == "docs/guide.md")
        self.assertEqual((guide["modified"], guide["open"]), ("2023-11-14T22:15:23.456789000Z", False))

        swaps = self.home / ".local/state/nvim/swap"
        swaps.mkdir(parents=True)
        marker = swaps / f"{str(target).replace('/', '%')}.swp"
        marker.touch()
        self.assertEqual(self.next_event(events, "index"), {})
        indexed = json.loads(self.request("GET", "/api/index")[2])
        guide = next(item for item in indexed["files"] if item["path"] == "docs/guide.md")
        self.assertTrue(guide["open"])

        marker.unlink()
        self.assertEqual(self.next_event(events, "index"), {})
        indexed = json.loads(self.request("GET", "/api/index")[2])
        guide = next(item for item in indexed["files"] if item["path"] == "docs/guide.md")
        self.assertFalse(guide["open"])

    def test_every_response_forbids_framing_and_sniffing(self) -> None:
        _status, headers, _body = self.request("GET", "/api/file?root=demo&path=docs/guide.md")
        paths = [("GET", "/", {}), ("GET", "/read/demo/docs/guide.md", {}), ("GET", "/app.js", {}),
                 ("GET", "/theme.css", {}), ("GET", "/api/index", {}), ("GET", "/nowhere", {}),
                 ("GET", "/raw/demo/.env", {}), ("GET", "/api/index", {"Host": "attacker.example"}),
                 ("GET", "/api/file?root=demo&path=docs/guide.md", {"If-None-Match": headers["etag"]}),
                 ("POST", "/api/edit", {"Content-Type": "text/plain"})]
        for method, path, extra in paths:
            status, headers, _body = self.request(method, path, {} if method == "POST" else None, headers=extra)
            self.assertEqual((path, headers.get("x-content-type-options"), headers.get("x-frame-options")), (path, "nosniff", "DENY"))
            self.assertIn("frame-ancestors 'none'", headers.get("content-security-policy", ""))
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        self.addCleanup(connection.close)
        connection.request("GET", "/api/events")
        response = connection.getresponse()
        self.assertEqual((response.getheader("X-Frame-Options"), response.getheader("Content-Security-Policy")), ("DENY", atlas_serve.PAGE_POLICY))

    def test_idle_request_socket_is_closed_after_the_timeout(self) -> None:
        self.assertEqual(atlas_serve.AtlasRequestHandler.timeout, 30.0)
        with mock.patch.object(atlas_serve.AtlasRequestHandler, "timeout", 0.2):
            with socket.create_connection(("127.0.0.1", self.port), timeout=3) as client:
                client.sendall(b"POST /api/edit HTTP/1.1\r\nHost: 127.0.0.1\r\n")
                started = time.monotonic()
                self.assertEqual(client.recv(1), b"")
                self.assertLess(time.monotonic() - started, 2)

    def test_non_utf8_filename_is_ascii_escaped_in_http_json(self) -> None:
        name = os.fsdecode(b"byte-\xff.md")
        (self.root / name).write_text("# Byte name\n", encoding="utf-8")
        status, _headers, body = self.request("GET", "/api/index")
        self.assertEqual(status, 200)
        self.assertTrue(body.isascii())
        self.assertIn(name, {file["path"] for file in json.loads(body)["files"]})
        # The reader sends the undecodable byte back as %FF.
        self.assertEqual(self.request("GET", "/read/demo/byte-%FF.md")[0], 200)
        for path in ("/api/file?root=demo&path=byte-%FF.md", "/raw/demo/byte-%FF.md"):
            status, _headers, body = self.request("GET", path)
            self.assertEqual((path, status), (path, 200))
            self.assertIn(b"Byte name", body)

    def test_api_file_decodes_tracked_toml_instead_of_restricting_content_to_markdown(self) -> None:
        status, _headers, body = self.request("GET", "/api/file?root=demo&path=settings.toml")
        document = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual((document["file"]["type"], document["content"]),
                         (".toml", 'theme = "atlas"\n'))
        self.assertNotIn("binary", document)

    def test_invalid_utf8_sets_binary_true_instead_of_decoding_with_replacement(self) -> None:
        status, _headers, body = self.request("GET", "/api/file?root=demo&path=blob.bin")
        document = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual((document["file"]["type"], document["binary"], document["bytes"]),
                         (".bin", True, 3))
        self.assertNotIn("content", document)

    def test_idle_sse_refresh_reports_body_saves_deletes_and_theme_changes(self) -> None:
        first_connection, first = self.event_client()
        second_connection, second = self.event_client()
        self.addCleanup(first_connection.close)
        self.addCleanup(second_connection.close)

        # This is a tracked file: its analytical git time remains unchanged,
        # and its replacement has equal byte/line counts, so only the internal
        # content fingerprint can make the file event observable.
        self.git("init")
        self.git("add", ".")
        self.git("-c", "user.name=Atlas", "-c", "user.email=atlas@example.test", "commit", "-m", "fixture")
        # Drain the refresh caused by switching this root to git timestamps.
        # Otherwise it can coalesce with the body rewrite below and produce an
        # index event instead of the file event this assertion is about.
        self.assertEqual(self.next_event(first, "index"), {})
        self.assertEqual(self.next_event(second, "index"), {})
        (self.root / "docs" / "guide.md").write_text("# Guide\n\nChanged body.\n", encoding="utf-8")
        first_file = self.next_event(first, "file")
        second_file = self.next_event(second, "file")
        self.assertEqual(first_file, {"root": "demo", "path": "docs/guide.md"})
        self.assertEqual(second_file, first_file)

        (self.root / "docs" / "guide.md").unlink()
        self.assertEqual(self.next_event(first, "file"), {"root": "demo", "path": "docs/guide.md"})
        for path in ("/api/file?root=demo&path=docs/guide.md", "/raw/demo/docs/guide.md"):
            status, _headers, body = self.request("GET", path)
            self.assertEqual((status, json.loads(body)["code"]), (404, "not_found"))

        old_css = self.request("GET", "/theme.css")[2]
        shutil.copyfile(FIXTURE / "theme" / "light" / "colors.toml", self.theme / "colors.toml")
        shutil.copyfile(FIXTURE / "theme" / "light" / "shell.toml", self.theme / "shell.toml")
        self.assertEqual(self.next_event(second, "theme"), {})
        light_css = self.request("GET", "/theme.css")[2]
        self.assertNotEqual(old_css, light_css)
        self.assertIn(b"--background: #eff1f5", light_css)
        self.assertIn(b"--orange: #d84e2b", light_css)
        (self.theme / "colors.toml").write_text("not valid = [", encoding="utf-8")
        self.wait_for("/theme.css", lambda reply: self.server.state.theme_error is not None)
        self.assertEqual(self.request("GET", "/theme.css")[2], light_css)
        self.assertIsNotNone(self.server.state.theme_error)

    def test_base_12_emits_12px_body_11px_small_and_28px_controls(self) -> None:
        css = self.request("GET", "/theme.css")[2].decode("utf-8")
        self.assertIn("  --font-size: 12px;", css)
        self.assertIn("  --font-size-small: 11px;", css)
        self.assertIn("  --control-height: 28px;", css)

    def test_dark_fixture_emits_named_orange_and_derives_color_1_from_red(self) -> None:
        css = self.request("GET", "/theme.css")[2].decode("utf-8")
        self.assertIn("  --orange: #eb927b;", css)
        self.assertIn("  --color-1: #f7768e;", css)

    def test_missing_brown_uses_its_fallback_while_other_named_colors_render(self) -> None:
        colors_path = self.theme / "colors.toml"
        colors_path.write_text(
            colors_path.read_text(encoding="utf-8").replace('brown = "#75493d"\n', ""),
            encoding="utf-8",
        )
        css = self.server.state.refresh_theme(force=True)
        self.assertIn("  --brown: #75493d;", css)
        self.assertIn("  --red: #f7768e;", css)

    def test_base_14_scales_default_control_height_to_33px(self) -> None:
        shutil.copyfile(FIXTURE / "theme" / "light" / "shell.toml", self.theme / "shell.toml")
        css = self.server.state.refresh_theme(force=True)
        self.assertIn("  --font-size: 14px;", css)
        self.assertIn("  --control-height: 33px;", css)

    def test_user_override_base_size_wins_over_theme_base_size(self) -> None:
        self.server.state.shell_override_path.write_text("[font]\nbase-size = 16\n", encoding="utf-8")
        css = self.server.state.refresh_theme(force=True)
        self.assertIn("  --font-size: 16px;", css)
        self.assertNotIn("  --font-size: 12px;", css)

    def test_normal_border_alpha_renders_as_rgba(self) -> None:
        css = self.request("GET", "/theme.css")[2].decode("utf-8")
        self.assertIn("  --control-border: rgba(238, 238, 255, 0.4);", css)

    def test_malformed_spacing_key_falls_back_without_discarding_other_tokens(self) -> None:
        self.server.state.shell_override_path.write_text(
            '[spacing]\ncontrol-height = "wide"\ncontrol-gap = 12\n', encoding="utf-8",
        )
        css = self.server.state.refresh_theme(force=True)
        self.assertIn("  --control-height: 28px;", css)
        self.assertIn("  --spacing: 12px;", css)

    def test_show_edit_and_launchers_use_window_pattern_and_url(self) -> None:
        first_connection, first = self.event_client()
        second_connection, second = self.event_client()
        self.addCleanup(first_connection.close)
        self.addCleanup(second_connection.close)
        status, _headers, body = self.request("POST", "/api/show", {"root": "demo", "path": "docs/guide.md", "view": "map"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"clients": 2})
        expected = {"root": "demo", "path": "docs/guide.md", "view": "map"}
        self.assertEqual(self.next_event(first, "show"), expected)
        self.assertEqual(self.next_event(second, "show"), expected)

        status, _headers, body = self.request("POST", "/api/edit", {"root": "demo", "path": "docs/guide.md"})
        self.assertEqual((status, json.loads(body)), (200, {"opened": True}))
        self.assertEqual(json.loads(self.launch_log.read_text(encoding="utf-8")), [str(self.root / "docs" / "guide.md")])
        url = "http://127.0.0.1:4137/read/Demo%20%CE%A9/docs/guide%20space.md"
        atlas_serve.launch_webapp(url, [sys.executable, str(FIXTURE / "record_launcher.py")])
        self.assertEqual(json.loads(self.launch_log.read_text(encoding="utf-8")), ["Markdown Atlas Reader", url])

    def test_disconnected_sse_client_is_dropped_within_one_refresh_tick(self) -> None:
        connection, response = self.event_client()
        self.assertEqual(self.server.state.client_count(), 1)
        response.close()
        connection.close()
        started = time.monotonic()
        deadline = started + 3
        while self.server.state.client_count() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(self.server.state.client_count(), 0)
        status, _headers, body = self.request("POST", "/api/show", {"root": "demo", "path": "docs/guide.md", "view": "read"})
        self.assertEqual((status, json.loads(body)), (200, {"clients": 0}))

    def test_overflowed_sse_stream_closes_and_replacement_receives_events(self) -> None:
        state = self.server.state
        state.get_index()
        _connection, stream = self.event_client()
        client = next(iter(state.clients))
        entered = threading.Event()
        release = threading.Event()
        original_get = client.get

        def pause_get(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise RuntimeError("SSE test reader did not resume")
            return original_get(*args, **kwargs)

        try:
            with mock.patch.object(client, "get", side_effect=pause_get):
                self.assertTrue(entered.wait(3))
                for number in range(client.maxsize - client.qsize()):
                    client.put_nowait(("file", {"root": "demo", "path": f"{number}.md"}, None))
                state._broadcast("file", {"root": "demo", "path": "overflow.md"})
                self.assertEqual(state.client_count(), 0)
                release.set()
                for _ in range(100):
                    if not stream.fp.readline():
                        break  # Drain events already written before the queue overflow.
                else:
                    self.fail("an evicted stream kept sending events instead of reaching EOF")
        finally:
            release.set()

        _replacement_connection, replacement = self.event_client()
        state._broadcast("file", {"root": "demo", "path": "after.md"})
        self.assertEqual(self.next_event(replacement, "file"), {"root": "demo", "path": "after.md"})

    def test_sixty_file_refresh_emits_one_index_event(self) -> None:
        state = self.server.state
        state.get_index()
        _connection, stream = self.event_client()
        client = next(iter(state.clients))
        entered = threading.Event()
        release = threading.Event()
        original_get = client.get

        def pause_get(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise RuntimeError("SSE test reader did not resume")
            return original_get(*args, **kwargs)

        try:
            with mock.patch.object(client, "get", side_effect=pause_get):
                self.assertTrue(entered.wait(3))
                for number in range(60):
                    (self.root / "docs" / f"burst-{number:02}.md").write_text("# Burst\n", encoding="utf-8")
                state.refresh_index(force=True)
                self.assertEqual(state.client_count(), 1, "a burst must keep the reader connected")
                queued = [event for event, _data, _delivery in list(client.queue)]
                self.assertEqual(queued.count("index"), 1, "a burst queues one index event")
                self.assertNotIn("file", queued, "a burst must not queue per-file events")
        finally:
            release.set()
        self.assertEqual(self.next_event(stream, "index"), {})

    def git(self, *args: str) -> None:
        environment = os.environ.copy()
        environment.update({"GIT_AUTHOR_DATE": "2020-01-02T03:04:05+00:00", "GIT_COMMITTER_DATE": "2020-01-02T03:04:05+00:00"})
        subprocess.run(["git", "-C", str(self.root), *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)


if __name__ == "__main__":
    unittest.main()
