import QtQuick
import qs.Commons
import qs.Ui
import "ui/IndexModel.js" as IndexModel

Column {
    id: view
    required property var atlas
    property alias searchField: searchField
    readonly property bool kindEditingText: kindsPage.editingText
    property alias pathField: rootsPage.pathField
    property alias searchRows: pages.searchRows
    property alias fileRows: pages.fileRows
    width: parent.width
    spacing: Style.space(12)
    PanelHero {
        width: parent.width
        title: "Markdown Atlas"
        meta: atlas.index.roots.length + " roots · " + atlas.index.files.length + " files · " + (atlas.indexedAt || "not indexed")
        foreground: atlas.bar ? atlas.bar.foreground : Color.foreground
        fontFamily: atlas.bar ? atlas.bar.fontFamily : Style.font.family
        iconComponent: Component {
            Text {
                text: "󰈙"
                color: atlas.bar ? atlas.bar.foreground : Color.foreground
                font.family: Style.font.family
                font.pixelSize: Style.font.display
            }
        }
    }
    PanelSeparator {
        foreground: atlas.bar ? atlas.bar.foreground : Color.foreground
    }
    TextField {
        id: searchField
        visible: !atlas.settingsPage
        width: parent.width
        placeholderText: "Find a file"
        text: atlas.query
        onTextEdited: atlas.requestSearch(text)
        Keys.onEscapePressed: atlas.closeFromEscape()
        Keys.onReturnPressed: {
            atlas.page = "files";
            atlas.focusPopup();
        }
        Keys.onEnterPressed: {
            atlas.page = "files";
            atlas.focusPopup();
        }
    }
    Text {
        visible: atlas.loading
        width: parent.width
        text: "Indexing…"
        color: Color.muted
        font.family: atlas.bar.fontFamily
        font.pixelSize: Style.font.bodySmall
    }
    AtlasActionButton {
        atlas: view.atlas
        visible: atlas.page !== "summary"
        text: "Back ⌫"
        onClicked: atlas.goBack()
    }
    Row {
        visible: atlas.refreshError !== "" || atlas.searchError !== "" || atlas.costError !== ""
        width: parent.width
        spacing: Style.space(6)
        Text {
            width: parent.width - retryButton.width - parent.spacing
            text: atlas.refreshError ? "Refresh failed: " + atlas.refreshError : atlas.searchError ? "Search failed: " + atlas.searchError : "Cost failed: " + atlas.costError
            textFormat: Text.PlainText
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
        }
        AtlasActionButton {
            id: retryButton
            atlas: view.atlas
            text: "Retry r"
            onClicked: atlas.retryFailure(IndexModel.failureCommand(atlas.refreshError, atlas.searchError, atlas.costError))
        }
    }
    AtlasActionButton {
        atlas: view.atlas
        visible: atlas.page === "summary" && atlas.noRoots
        width: parent.width
        text: "No roots registered · Choose roots"
        onClicked: atlas.openRoots()
    }
    Flow {
        visible: atlas.page === "summary"
        width: parent.width
        spacing: Style.space(6)
        AtlasActionButton {
            atlas: view.atlas
            text: "Roots"
            onClicked: atlas.openRoots()
        }
        AtlasActionButton {
            atlas: view.atlas
            text: "Kinds"
            onClicked: atlas.openKinds()
        }
        Repeater {
            model: IndexModel.rootOptions(atlas.index)
            delegate: AtlasActionButton {
                atlas: view.atlas
                required property var modelData
                text: modelData.name + " " + modelData.count
                selected: atlas.selectedRoots.indexOf(modelData.name) !== -1
                onClicked: atlas.selectedRoots = atlas.toggled(atlas.selectedRoots, modelData.name)
            }
        }
    }
    Column {
        visible: atlas.page === "summary"
        width: parent.width
        spacing: Style.space(8)
        PanelSectionHeader {
            width: parent.width
            text: "FINDINGS"
            foreground: atlas.bar ? atlas.bar.foreground : Color.foreground
            fontFamily: Style.font.family
        }
        PanelFindingRow {
            atlas: view.atlas
            position: 0
            label: "Orphan files"
            value: atlas.counts.orphans + " files"
            onClicked: atlas.openFinding(0)
        }
        PanelFindingRow {
            atlas: view.atlas
            position: 1
            label: "Dangling references"
            value: atlas.counts.dangling + " references"
            onClicked: atlas.openFinding(1)
        }
        PanelFindingRow {
            atlas: view.atlas
            position: 2
            label: "Stale files"
            value: atlas.counts.stale + " files"
            onClicked: atlas.openFinding(2)
        }
        PanelFindingRow {
            atlas: view.atlas
            position: 3
            label: "Recently edited"
            value: atlas.recencyCounts.recent + " files"
            onClicked: atlas.openFinding(3)
        }
        Text {
            visible: atlas.unavailableLabels.length > 0
            width: parent.width
            text: atlas.unavailableLabels.join(" · ")
            textFormat: Text.PlainText
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
        }
        Row {
            id: summaryActions
            width: parent.width
            spacing: Style.spacing.md
            readonly property real cellWidth: (width - spacing * 3) / 4
            AtlasActionButton {
                atlas: view.atlas
                width: summaryActions.cellWidth
                text: "All files"
                onClicked: {
                    atlas.findings = ({});
                    atlas.page = "files";
                }
            }
            AtlasActionButton {
                atlas: view.atlas
                width: summaryActions.cellWidth
                text: "Map m"
                enabled: atlas.index.files.length > 0
                tooltipText: enabled ? "" : "Index a root to open the map"
                onClicked: atlas.showSelected(true, true)
            }
            AtlasActionButton {
                atlas: view.atlas
                width: summaryActions.cellWidth
                text: "Filters"
                onClicked: atlas.page = "filters"
            }
            AtlasActionButton {
                atlas: view.atlas
                width: summaryActions.cellWidth
                text: "Refresh r"
                onClicked: atlas.refreshIndex()
            }
        }
    }
    PanelRoots {
        id: rootsPage
        atlas: view.atlas
    }
    PanelKinds {
        id: kindsPage
        atlas: view.atlas
    }
    PanelPages {
        id: pages
        atlas: view.atlas
    }
}
