from __future__ import annotations

import json
import re
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]


class PluginAssemblyTests(unittest.TestCase):
    def test_bridge_accepts_one_json_reply(self) -> None:
        bridge = (ROOT / "PanelBridge.js").read_text(encoding="utf-8").replace(".pragma library\n", "", 1)
        program = bridge + "\nconsole.log(JSON.stringify(parseReply('{\\\"version\\\":1,\\\"ok\\\":true,\\\"command\\\":\\\"index\\\",\\\"data\\\":{}}\\n', 'index')));"
        completed = subprocess.run(["node", "-e", program], check=True, capture_output=True, text=True)
        self.assertTrue(json.loads(completed.stdout)["valid"])

    def test_mount_picker_preserves_paths_and_rejects_invalid_data(self) -> None:
        bridge = (ROOT / "PanelBridge.js").read_text(encoding="utf-8").replace(".pragma library\n", "", 1)
        mounts = {"filesystems": [
            {"target": "/", "source": "/dev/sda2", "fstype": "ext4"},
            {"target": "/media/My drive", "source": "/dev/sdb1", "fstype": "ext4"},
            {"target": "/media/My drive", "source": "/dev/sdb1", "fstype": "ext4"},
        ]}
        inputs = [json.dumps(mounts), '{"filesystems":[]}', '{}', 'not JSON',
                  '{"filesystems":[{"target":"relative"}]}']
        program = bridge + "\nconsole.log(JSON.stringify(" + json.dumps(inputs) + ".map(parseMounts)));"
        completed = subprocess.run(["node", "-e", program], check=True, capture_output=True, text=True)
        replies = json.loads(completed.stdout)
        self.assertEqual(replies[0], {"valid": True, "drives": mounts["filesystems"][:2]})
        self.assertEqual(replies[1], {"valid": True, "drives": []})
        self.assertTrue(all(not reply["valid"] for reply in replies[2:]))

    def test_panel_text_showing_index_data_is_plain_text(self) -> None:
        # Qt's default AutoText renders a title such as <img src="https://...">
        # as rich text and fetches the image from the shell.
        checked = []
        for path in sorted(ROOT.glob("Panel*.qml")):
            source = path.read_text(encoding="utf-8")
            for match in re.finditer(r"^( *)(?:delegate: )?Text \{\n(.*?)^\1\}", source, re.M | re.S):
                body = match[2]
                binding = re.search(r"^" + match[1] + r"    text: (.*)$", body, re.M)
                if binding is None or re.fullmatch(r'"[^"]*"', binding[1]):
                    continue
                checked.append(binding[1])
                self.assertIn("textFormat: Text.PlainText", body, f"{path.name}: text: {binding[1]}")
        self.assertIn("atlas.selectedFacts ? atlas.selectedFacts.file.title : \"No file selected\"", checked)
        self.assertGreaterEqual(len(checked), 20)

    def test_popup_and_bar_tooltip_name_unavailable_entries_by_reason(self) -> None:
        panel = (ROOT / "Panel.qml").read_text(encoding="utf-8")
        content = (ROOT / "PanelContent.qml").read_text(encoding="utf-8")
        self.assertIn("readonly property var unavailableLabels: IndexModel.unavailableLabels(index.unavailable)", panel)
        self.assertIn('unavailableLabels.length ? "Atlas: " + unavailableLabels.join(" · ")', panel)
        self.assertIn('text: atlas.unavailableLabels.join(" · ")', content)
        self.assertNotIn("Stale analysis unavailable", panel + content)

    def test_settings_keyboard_activates_focused_control_once(self) -> None:
        popup = (ROOT / "PanelPopup.qml").read_text(encoding="utf-8")
        roots = (ROOT / "PanelRoots.qml").read_text(encoding="utf-8")
        kinds = (ROOT / "PanelKinds.qml").read_text(encoding="utf-8")
        kind_row = (ROOT / "PanelKindRow.qml").read_text(encoding="utf-8")
        button = (ROOT / "AtlasActionButton.qml").read_text(encoding="utf-8")

        def body(source: str, declaration: str, indent: int) -> str:
            match = re.search(re.escape(declaration) + r" \{(.*?)\n" + " " * indent + r"\}", source, re.S)
            self.assertIsNotNone(match, declaration)
            return match[1]

        functions = "\n".join(
            "function " + name + "() {" + body(popup, "function " + name + "()", 4) + "}"
            for name in ("focusedControl", "returnPressed", "spacePressed")
        )
        handlers = {
            "enter": body(popup, "onReturnRequested:", 8),
            "activate": body(popup, "onActivateRequested:", 8),
        }
        accepted = re.search(r"onAccepted: ([^\n]+)", roots)
        self.assertIsNotNone(accepted, "onAccepted")
        root_actions = []
        for label in ("Whole system", "A drive", "Remove", "Add path ↵"):
            match = re.search(r'text: "' + re.escape(label) + r'".*?onClicked: ([^\n]+)', roots, re.S)
            self.assertIsNotNone(match, label)
            root_actions.append(match[1])
        root_actions.append(body(roots, "function activateControl()", 12))

        def clicked(source: str, marker: str) -> str:
            match = re.search(re.escape(marker) + r".*?onClicked: ([^\n]+)", source, re.S)
            self.assertIsNotNone(match, marker)
            return match[1]

        kind_actions = [
            {"page": "kinds", "model": "kind", "action": clicked(kinds, "delegate: PanelKindRow {")},
            {"page": "kinds", "model": "kind", "action": clicked(kinds, 'text: "Add kind"')},
            {"page": "kind-editor", "model": "colour", "action": clicked(kinds, 'text: "●"')},
            {"page": "kind-editor", "model": "kind", "action": clicked(kinds, 'text: "Save"')},
            {"page": "kind-editor", "model": "kind", "action": clicked(kinds, 'text: atlas.kindDraft.builtin')},
        ]
        program = functions + "\n" + "\n".join([
            "const handlers = " + json.dumps(handlers) + ";",
            "const rootActions = " + json.dumps(root_actions) + ";",
            "const kindActions = " + json.dumps(kind_actions) + ";",
            "const buttonBody = " + json.dumps(body(button, "function activateControl()", 4)) + ";",
            "const rowBody = " + json.dumps(body(kind_row, "function activateControl()", 4)) + ";",
            "const calls = [];",
            "const atlas = {page: 'roots', kindDraft: {id: 'notes', builtin: true},",
            "    changeRoot: (...args) => calls.push(args),",
            "    editKind: kind => calls.push(['edit-kind', kind && kind.id]),",
            "    changeKind: (command, draft) => calls.push([command, draft.id]),",
            "    loadDrives: () => calls.push(['mounts']), activateSelection: () => calls.push(['wrong-selection'])};",
            "const rootModel = {name: 'registered', target: '/media/My drive'};",
            "const kindModel = {id: 'notes'};",
            "const pathField = {text: '/a path'};",
            "let chosenColour = 'red';",
            "const kindView = {save: () => atlas.changeKind('kind-set', atlas.kindDraft)};",
            "Object.defineProperty(kindView, 'chosenColour', {get: () => chosenColour, set: value => {chosenColour = value; calls.push(['colour', value]);}});",
            "const keyCatcher = {Window: {window: {activeFocusItem: null}}};",
            "const view = {returning: false, returnPressed, spacePressed};",
            "const enter = new Function('view', handlers.enter);",
            "const activate = new Function('view', handlers.activate);",
            "new Function('atlas', 'text', " + json.dumps(accepted.group(1)) + ")(atlas, '/accepted path');",
            "function checkControl(page, action, activationBody, modelData) {",
            "    atlas.page = page;",
            "    const click = new Function('atlas', 'modelData', 'pathField', 'view', action).bind(null, atlas, modelData, pathField, kindView);",
            "    const control = {enabled: true, activateControl: activationBody ? new Function('clicked', activationBody).bind(null, click) : click};",
            "    keyCatcher.Window.window.activeFocusItem = control;",
            "    enter(view); activate(view);",  # Native catcher emits both for Enter.
            "    activate(view);",  # Space emits only activateRequested.
            "    control.enabled = false;",
            "    enter(view); activate(view); activate(view);",
            "}",
            "for (let i = 0; i < rootActions.length; i++)",
            "    checkControl('roots', rootActions[i], i === 4 ? null : buttonBody, rootModel);",
            "for (const action of kindActions)",
            "    checkControl(action.page, action.action, action === kindActions[0] ? rowBody : buttonBody, action.model === 'colour' ? 'blue' : kindModel);",
            "console.log(JSON.stringify(calls));",
        ])
        completed = subprocess.run(["node", "-e", program], check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(completed.stdout), [
            ["root-add", "/accepted path"],
        ] + [
            ["root-add", "/"], ["root-add", "/"],
            ["mounts"], ["mounts"],
            ["root-remove", "registered"], ["root-remove", "registered"],
            ["root-add", "/a path"], ["root-add", "/a path"],
            ["root-add", "/media/My drive"], ["root-add", "/media/My drive"],
            ["edit-kind", "notes"], ["edit-kind", "notes"],
            ["edit-kind", None], ["edit-kind", None],
            ["colour", "blue"], ["colour", "blue"],
            ["kind-set", "notes"], ["kind-set", "notes"],
            ["kind-remove", "notes"], ["kind-remove", "notes"],
        ])

    def test_offline_fixture_probe_prints_honest_metrics(self) -> None:
        completed = subprocess.run(
            [sys.executable, "-B", str(ROOT / "tests" / "smoke" / "probe_fixture.py")],
            check=True,
            capture_output=True,
            text=True,
        )
        metrics = json.loads(completed.stdout)
        self.assertEqual(metrics["probe"], "fixture-index")
        self.assertGreater(metrics["files"], 0)
        self.assertGreaterEqual(metrics["references"], 0)
