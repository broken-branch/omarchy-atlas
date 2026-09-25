import QtQuick
import Quickshell
import Quickshell.Io

Item {
    id: root

    property var manifest: null
    property var exits: []
    readonly property string pluginId: manifest && manifest.id ? String(manifest.id) : "io.github.broken-branch.atlas"
    readonly property string backendPath: decodeURIComponent(Qt.resolvedUrl("atlas.py").toString().replace("file://", ""))

    function restartDelay() {
        var now = Date.now();
        var recent = exits.filter(function (time) {
            return now - time <= 60000;
        });
        exits = recent;
        return recent.length >= 5 ? 30000 : 2000;
    }

    Process {
        id: server
        command: ["setpriv", "--pdeathsig", "TERM", "python3", "-B", root.backendPath, "serve"]
        stderr: StdioCollector {
            waitForEnd: false
            onStreamFinished: console.warn("[" + root.pluginId + "] " + String(text || ""))
        }
        onExited: exitCode => {
            console.warn("[" + root.pluginId + "] server exited " + exitCode);
            root.exits = root.exits.concat([Date.now()]);
            restartTimer.interval = root.restartDelay();
            restartTimer.restart();
        }
    }

    Timer {
        id: restartTimer
        repeat: false
        onTriggered: server.running = true
    }

    Component.onCompleted: server.running = true
}
