import QtQuick
import QtQuick.Window
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "PanelBridge.js" as PanelBridge
import "ui/IndexModel.js" as IndexModel

Panel {
    id: root
    moduleName: "io.github.broken-branch.atlas"
    ipcTarget: "io.github.broken-branch.atlas"
    manageIpc: false
    property var index: ({
            kinds: [],
            roots: [],
            files: [],
            references: [],
            summary: {},
            unavailable: []
        })
    property var searchMatches: []
    property var costRows: []
    property var registeredRoots: []
    property var kindTable: index.kinds || []
    property var kindDraft: ({})
    property bool kindsBusy: false
    property string kindsError: ""
    property string kindsErrorField: ""
    property var themeKindColours: ({})
    readonly property bool settingsPage: page === "roots" || page === "kinds" || page === "kind-editor"
    function kindColour(name) {
        if (name.charAt(0) === "#")
            return name;
        return Color[name] || themeKindColours[name] || Color.foreground;
    }
    function openKinds() {
        page = "kinds";
        kindsError = "";
        enqueue("kinds", [], "kinds");
        focusPopup();
    }
    function editKind(kind) {
        kindDraft = kind ? {
            id: kind.id,
            label: kind.label,
            colour: kind.colour,
            builtin: kind.builtin,
            overridden: kind.overridden,
            adding: false,
            paths: kind.match.paths.join("\n"),
            extensions: kind.match.extensions.join("\n")
        } : {
            id: "",
            label: "",
            colour: "accent",
            builtin: false,
            adding: true,
            paths: "",
            extensions: ""
        };
        kindsError = "";
        page = "kind-editor";
        focusPopup();
    }
    function changeKind(command, draft) {
        if (kindsBusy)
            return;
        kindsError = "";
        if (command === "kind-set" && draft.adding && kindTable.some(function (kind) {
            return kind.id === draft.id;
        })) {
            kindsError = "This id already exists. Select its kind to edit it.";
            kindsErrorField = "id";
            return;
        }
        var result = command === "kind-set" ? PanelBridge.kindArguments(draft) : {
            arguments: [draft.id]
        };
        if (result.error) {
            kindsError = result.error;
            kindsErrorField = result.field;
            return;
        }
        kindsBusy = true;
        enqueue(command, result.arguments, "kind-change");
    }
    property var drives: []
    property bool rootsBusy: false
    property bool drivesLoading: false
    property bool showDrives: false
    property string rootsError: ""
    property string drivesError: ""
    property string selectedRoot: ""
    property string selectedPath: ""
    property string page: "summary"
    property int selectedFinding: 0
    property string query: ""
    property var selectedRoots: []
    property var selectedKinds: []
    property var findings: ({})
    property bool loading: false
    property bool closeAfterAction: false
    property bool noRoots: false
    property string refreshError: ""
    property string searchError: ""
    property string costError: ""
    property int selectedSearchRow: -1
    property string indexedAt: ""
    property double recencyNow: Date.now()
    property var requestQueue: []
    property var activeRequest: null
    property var latestRequest: ({})
    property int nextRequestId: 1
    readonly property string backendPath: PanelBridge.localPath(Qt.resolvedUrl("atlas.py"))
    readonly property var counts: IndexModel.findingCounts(index.files)
    readonly property var recencyCounts: IndexModel.recencyCounts(index.files, recencyNow)
    readonly property color recencyRed: IndexModel.recencyColour(themeKindColours, Color.urgent, false)
    readonly property color recencyOrange: IndexModel.recencyColour(themeKindColours, Color.urgent, true)
    readonly property var unavailableLabels: IndexModel.unavailableLabels(index.unavailable)
    readonly property var selectedFacts: IndexModel.facts(index, selectedRoot, selectedPath, costRows)
    readonly property var visibleFiles: IndexModel.filterFiles(index, {
        roots: selectedRoots,
        kinds: selectedKinds,
        query: query,
        findings: findings,
        now: recencyNow
    }, searchMatches)
    readonly property var visibleSearchMatches: IndexModel.filterMatches(searchMatches, visibleFiles, findings.recent === true)
    readonly property string barStatus: (refreshError !== "" ? "Markdown Atlas: " + refreshError : unavailableLabels.length ? "Markdown Atlas: " + unavailableLabels.join(" · ") : "Markdown Atlas: " + index.files.length + " files in " + index.roots.length + " roots · indexed " + (indexedAt || "not yet")) + (IndexModel.barRecency(recencyCounts) ? " · " + IndexModel.barRecency(recencyCounts) : "")
    visible: true
    implicitWidth: button.implicitWidth
    implicitHeight: button.implicitHeight
    function openPopup() {
        recencyNow = Date.now();
        if (!root.opened)
            root.open();
        page = "summary";
        kindPalette.reload();
        refreshIndex();
        Qt.callLater(function () {
            popup.keyCatcher.forceActiveFocus();
        });
    }
    function closePopup() {
        cancelPendingRequests();
        root.close();
    }
    function cancelPendingRequests() {
        searchTimer.stop();
        requestTimeout.stop();
        requestQueue = [];
        activeRequest = null;
        latestRequest = ({});
        loading = false;
        rootsBusy = false;
        kindsBusy = false;
        drivesLoading = false;
        if (backend.running)
            backend.running = false;
    }
    function refreshIndex() {
        if (!root.opened)
            return;
        loading = true;
        refreshError = "";
        enqueue("index", [], "index");
    }
    function openRoots() {
        page = "roots";
        rootsError = "";
        enqueue("roots", [], "roots");
    }
    function changeRoot(command, value) {
        if (rootsBusy)
            return;
        rootsBusy = true;
        rootsError = "";
        enqueue(command, [value], "root-change");
    }
    function loadDrives() {
        showDrives = true;
        drivesLoading = true;
        drivesError = "";
        enqueue("mounts", [], "mounts");
    }
    function enqueue(command, argumentsList, key) {
        if (!root.opened && command !== "show")
            return;
        var request = {
            id: nextRequestId++,
            command: command,
            arguments: argumentsList || [],
            key: key || "",
            stdout: "",
            stdoutDone: false,
            exitSeen: false,
            exitCode: -1,
            timedOut: false
        };
        if (request.key)
            latestRequest[request.key] = request.id;
        var queued = requestQueue.filter(function (item) {
            return !request.key || item.key !== request.key;
        });
        queued.push(request);
        requestQueue = queued;
        startNextRequest();
    }
    function isNoRootsReply(request) {
        var parsed = PanelBridge.parseReply(request.stdout, request.command);
        return request.command === "index" && parsed.valid && parsed.reply.code === "no_roots";
    }
    function startNextRequest() {
        if (activeRequest || backend.running || requestQueue.length === 0)
            return;
        var queued = requestQueue.slice();
        var request = queued.shift();
        requestQueue = queued;
        if ((!root.opened && request.command !== "show") || (request.key && latestRequest[request.key] !== request.id)) {
            Qt.callLater(startNextRequest);
            return;
        }
        activeRequest = request;
        backend.command = request.command === "mounts" ? ["findmnt", "-J", "--real", "--list", "--output", "TARGET,SOURCE,FSTYPE"] : ["python3", "-B", backendPath, request.command].concat(request.arguments).concat(["--json"]);
        requestTimeout.interval = PanelBridge.requestTimeout(request.command);
        requestTimeout.restart();
        backend.running = true;
    }
    function maybeFinishRequest() {
        var request = activeRequest;
        if (!request || !request.exitSeen || !request.stdoutDone)
            return;
        requestTimeout.stop();
        activeRequest = null;
        if (request.command === "index")
            loading = false;
        if ((!request.key || latestRequest[request.key] === request.id) && (root.opened || request.command === "show")) {
            if (request.timedOut)
                handleFailure(request, "The backend request timed out.");
            else if (request.exitCode !== 0 && !isNoRootsReply(request))
                handleFailure(request, "The backend process failed.");
            else
                handleReply(request);
        }
        if (request.command === "show" && closeAfterAction && root.opened && !refreshError) {
            closeAfterAction = false;
            closePopup();
        }
        Qt.callLater(startNextRequest);
    }
    function handleReply(request) {
        if (request.command === "mounts") {
            var mounts = PanelBridge.parseMounts(request.stdout);
            drivesLoading = false;
            if (!mounts.valid) {
                handleFailure(request, mounts.message);
                return;
            }
            drives = mounts.drives;
            return;
        }
        var parsed = PanelBridge.parseReply(request.stdout, request.command);
        if (!parsed.valid || (!parsed.reply.ok && !(request.command === "index" && parsed.reply.code === "no_roots"))) {
            handleFailure(request, parsed.valid ? String(parsed.reply.message || "The request failed.") : parsed.message);
            return;
        }
        if (request.command === "index" && parsed.reply.code === "no_roots") {
            index = ({
                    roots: [],
                    files: [],
                    references: [],
                    summary: {},
                    unavailable: []
                });
            searchMatches = [];
            costRows = [];
            noRoots = true;
            refreshError = "";
            indexedAt = "";
            registeredRoots = [];
            if (page !== "kinds" && page !== "kind-editor")
                openRoots();
            return;
        }
        var data = parsed.reply.data || {};
        if (request.command === "kinds") {
            if (!Array.isArray(data.kinds)) {
                handleFailure(request, "The backend reply omitted its kinds.");
                return;
            }
            kindTable = data.kinds;
            selectedKinds = selectedKinds.filter(function (id) {
                return kindTable.some(function (kind) {
                    return kind.id === id;
                });
            });
        } else if (request.command === "kind-set" || request.command === "kind-remove") {
            kindsBusy = false;
            openKinds();
            refreshIndex();
        } else if (request.command === "roots" || request.command === "root-add" || request.command === "root-remove") {
            if (!data.config || !Array.isArray(data.config.roots)) {
                handleFailure(request, "The backend reply omitted its roots.");
                return;
            }
            registeredRoots = data.config.roots;
            rootsError = "";
            if (request.command !== "roots") {
                rootsBusy = false;
                selectedRoots = selectedRoots.filter(function (name) {
                    return registeredRoots.some(function (item) {
                        return item.name === name;
                    });
                });
                if (request.command === "root-add")
                    popup.pathField.text = "";
                refreshIndex();
            }
        } else if (request.command === "index") {
            var nextIndex = PanelBridge.indexData(data);
            if (!nextIndex) {
                handleFailure(request, "The backend reply omitted its index.");
                return;
            }
            index = nextIndex;
            kindTable = nextIndex.kinds || [];
            if (query)
                runSearch();
            noRoots = false;
            indexedAt = PanelBridge.ageText(nextIndex.generatedAt);
            refreshError = "";
            if (!selectedFacts && nextIndex.files.length)
                selectFile(nextIndex.files[0].root, nextIndex.files[0].path);
            enqueue("cost", [], "cost");
        } else if (request.command === "search") {
            searchMatches = PanelBridge.searchData(data);
            searchError = "";
            selectedSearchRow = -1;
        } else if (request.command === "cost") {
            costRows = data.roots || [];
            costError = "";
        }
    }
    function handleFailure(request, message) {
        if (request.command === "kinds" || request.command === "kind-set" || request.command === "kind-remove") {
            kindsBusy = false;
            kindsError = message;
            kindsErrorField = PanelBridge.kindErrorField(message);
            return;
        }
        if (request.command === "mounts") {
            drivesLoading = false;
            drives = [];
            drivesError = "Drive list unavailable: " + message;
            return;
        }
        if (request.command === "roots" || request.command === "root-add" || request.command === "root-remove") {
            rootsBusy = false;
            rootsError = message;
            return;
        }
        if (request.command === "search") {
            searchMatches = [];
            searchError = message;
            selectedSearchRow = -1;
            return;
        }
        if (request.command === "cost") {
            costError = message;
            return;
        }
        refreshError = message;
    }
    function requestSearch(value) {
        query = value;
        selectedSearchRow = -1;
        searchError = "";
        searchTimer.restart();
    }
    function toggled(values, value) {
        var next = Array.from(values || []);
        var position = next.indexOf(value);
        if (position === -1)
            next.push(value);
        else
            next.splice(position, 1);
        return next;
    }
    function toggleFinding(name) {
        var next = Object.assign({}, findings);
        next[name] = !next[name];
        findings = next;
    }
    function runSearch() {
        var value = String(query || "").trim();
        if (!value) {
            searchMatches = [];
            return;
        }
        enqueue("search", [value], "search");
    }
    function retryFailure(command) {
        if (command === "search")
            runSearch();
        else if (command === "cost")
            enqueue("cost", [], "cost");
        else
            refreshIndex();
    }
    function selectFile(rootName, path) {
        selectedRoot = rootName;
        selectedPath = path;
    }
    function moveRootsFocus(forward) {
        var focused = popup.keyCatcher.Window.window.activeFocusItem || popup.keyCatcher;
        focused.nextItemInFocusChain(forward).forceActiveFocus(Qt.TabFocusReason);
    }
    function focusPopup() {
        popup.keyCatcher.forceActiveFocus();
    }
    function revealControl(item) {
        popup.revealControl(item);
    }
    function moveSelection(offset) {
        if (settingsPage || page === "filters") {
            moveRootsFocus(offset > 0);
            return;
        }
        if (page === "summary") {
            selectedFinding = Math.max(0, Math.min(3, selectedFinding + offset));
            return;
        }
        var files = visibleFiles;
        if (page !== "files" || offset === 0)
            return;
        if (query) {
            var nextRow = IndexModel.nextRowIndex(visibleSearchMatches, selectedSearchRow, offset);
            if (nextRow < 0)
                return;
            selectedSearchRow = nextRow;
            selectFile(visibleSearchMatches[nextRow].file.root, visibleSearchMatches[nextRow].file.path);
            Qt.callLater(function () {
                root.scrollSelectedIntoView();
            });
            return;
        }
        if (!files.length)
            return;
        var current = -1;
        for (var i = 0; i < files.length; ++i) {
            if (files[i].root === selectedRoot && files[i].path === selectedPath) {
                current = i;
                break;
            }
        }
        var next = current === -1 ? (offset < 0 ? files.length - 1 : 0) : Math.max(0, Math.min(files.length - 1, current + offset));
        selectFile(files[next].root, files[next].path);
        Qt.callLater(function () {
            root.scrollSelectedIntoView();
        });
    }
    function scrollSelectedIntoView() {
        var rows = query ? popup.searchRows : popup.fileRows;
        if (query && selectedSearchRow >= 0 && selectedSearchRow < rows.count) {
            revealControl(rows.itemAt(selectedSearchRow));
            return;
        }
        for (var i = 0; i < rows.count; ++i) {
            var item = rows.itemAt(i);
            var file = item && query ? item.modelData.file : item ? item.modelData : null;
            if (file && file.root === selectedRoot && file.path === selectedPath) {
                revealControl(item);
                return;
            }
        }
    }
    function openFacts(rootName, path) {
        selectFile(rootName, path);
        page = "facts";
    }
    function showSelected(map, closeWhenDone) {
        if (map && !selectedFacts && index.files.length)
            selectFile(index.files[0].root, index.files[0].path);
        if (!selectedFacts)
            return;
        var args = ["--root", selectedRoot, "--path", selectedPath];
        if (map)
            args.push("--map");
        closeAfterAction = closeWhenDone === true;
        enqueue("show", args, "show");
    }
    function readSelected() {
        showSelected(false, true);
    }
    function editSelected() {
        if (selectedFacts)
            enqueue("edit", ["--root", selectedRoot, "--path", selectedPath], "edit");
    }
    function openFinding(position) {
        var names = ["orphans", "dangling", "stale", "recent"];
        var next = {};
        next[names[position]] = true;
        findings = next;
        page = "files";
    }
    function activateSelection() {
        if (page === "summary")
            openFinding(selectedFinding);
        else if (page === "files" || page === "facts")
            readSelected();
    }
    function goBack() {
        if (page === "kind-editor") {
            page = "kinds";
            focusPopup();
        } else if (page === "details")
            page = "facts";
        else if (page === "facts")
            page = "files";
        else if (page === "files" || page === "filters" || page === "roots" || page === "kinds")
            page = "summary";
        else
            closePopup();
    }
    function closeFromEscape() {
        if (popup.searchField.activeFocus && popup.searchField.text !== "") {
            var cleared = IndexModel.clearedSearch();
            popup.searchField.text = "";
            query = cleared.query;
            searchMatches = cleared.matches;
            searchError = cleared.error;
            selectedSearchRow = -1;
            return;
        }
        closePopup();
    }
    onOpenedChanged: if (!opened)
        cancelPendingRequests()
    FileView {
        id: kindPalette
        path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: {
            var colours = PanelBridge.themeColours(text());
            if (Object.keys(colours).length)
                root.themeKindColours = colours;
        }
    }
    IpcHandler {
        target: root.ipcTarget
        function open(): void {
            root.openPopup();
        }
        function close(): void {
            root.closePopup();
        }
        function toggle(): void {
            if (root.opened)
                root.closePopup();
            else
                root.openPopup();
        }
    }
    Process {
        id: backend
        stdout: StdioCollector {
            waitForEnd: true
            onStreamFinished: {
                if (!root.activeRequest)
                    return;
                root.activeRequest.stdout = String(text || "");
                root.activeRequest.stdoutDone = true;
                root.maybeFinishRequest();
            }
        }
        onExited: exitCode => {
            if (!root.activeRequest)
                return;
            root.activeRequest.exitCode = exitCode;
            root.activeRequest.exitSeen = true;
            root.maybeFinishRequest();
        }
    }
    Timer {
        id: requestTimeout
        repeat: false
        onTriggered: {
            if (!root.activeRequest)
                return;
            root.activeRequest.timedOut = true;
            if (backend.running)
                backend.running = false;
        }
    }
    Timer {
        id: searchTimer
        interval: 180
        repeat: false
        onTriggered: root.runSearch()
    }
    Timer {
        interval: 30000
        repeat: true
        running: true
        onTriggered: root.recencyNow = Date.now()
    }
    BarIconButton {
        id: button
        anchors.fill: parent
        bar: root.bar
        text: "󰈙"
        tooltipText: root.barStatus
        Accessible.name: "Markdown Atlas"
        active: root.opened
        onPressed: function (buttonCode) {
            if (buttonCode === Qt.LeftButton)
                root.openPopup();
            else if (buttonCode === Qt.RightButton)
                root.showSelected(false, false);
        }
    }
    Rectangle {
        width: Style.space(7)
        height: width
        radius: width / 2
        anchors.right: button.right
        anchors.top: button.top
        color: root.recencyRed
        visible: root.recencyCounts.red > 0
    }
    PanelPopup {
        id: popup
        atlas: root
        anchorButton: button
    }
}
