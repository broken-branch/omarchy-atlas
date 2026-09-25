import QtQuick
import qs.Commons
import qs.Ui
import "ui/IndexModel.js" as IndexModel

Column {
    id: view
    required property var atlas
    property alias searchRows: searchRows
    property alias fileRows: fileRows
    width: parent.width
    spacing: Style.space(12)
    Column {
        visible: atlas.page === "files"
        width: parent.width
        spacing: Style.space(8)
        PanelSectionHeader {
            width: parent.width
            text: atlas.query ? "SEARCH RESULTS" : "FILES"
            foreground: atlas.bar ? atlas.bar.foreground : Color.foreground
            fontFamily: Style.font.family
        }
        Repeater {
            id: searchRows
            model: atlas.query ? atlas.visibleSearchMatches : []
            delegate: PanelFileRow {
                atlas: view.atlas
                required property var modelData
                required property int index
                file: modelData.file
                searchRowIndex: index
                caption: (modelData.line > 0 ? "Line " + modelData.line + " · " : "") + modelData.text
            }
        }
        Text {
            visible: atlas.query && atlas.searchMatches.length === 200
            width: parent.width
            text: "Showing first 200 matches."
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
        }
        Repeater {
            id: fileRows
            model: atlas.query ? [] : atlas.visibleFiles
            delegate: PanelFileRow {
                atlas: view.atlas
                required property var modelData
                file: modelData
                caption: IndexModel.kindLabel(atlas.index.kinds, modelData.kind) + (modelData.orphan ? " · orphan" : "") + (modelData.dangling > 0 ? " · dangling " + modelData.dangling : "") + (modelData.stale ? " · stale" : "")
            }
        }
        Text {
            visible: atlas.visibleFiles.length === 0
            width: parent.width
            text: atlas.query ? "No files match this search." : "No files in these roots."
            textFormat: Text.PlainText
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.body
        }
    }
    Column {
        visible: atlas.page === "filters"
        width: parent.width
        spacing: Style.space(8)
        PanelSectionHeader {
            width: parent.width
            text: "FILTERS"
            foreground: atlas.bar ? atlas.bar.foreground : Color.foreground
            fontFamily: Style.font.family
        }
        PanelSectionHeader {
            width: parent.width
            text: "KINDS"
            foreground: atlas.bar ? atlas.bar.foreground : Color.foreground
            fontFamily: Style.font.family
        }
        Repeater {
            model: IndexModel.kindOptions(atlas.index)
            delegate: PanelKindRow {
                atlas: view.atlas
                required property var modelData
                kind: modelData
                selected: atlas.selectedKinds.indexOf(modelData.id) !== -1
                onClicked: atlas.selectedKinds = atlas.toggled(atlas.selectedKinds, modelData.id)
            }
        }
        PanelSectionHeader {
            width: parent.width
            text: "FINDINGS"
            foreground: atlas.bar ? atlas.bar.foreground : Color.foreground
            fontFamily: Style.font.family
        }
        AtlasActionButton {
            atlas: view.atlas
            width: parent.width
            text: "Orphan files"
            selected: atlas.findings.orphans === true
            onClicked: atlas.toggleFinding("orphans")
        }
        AtlasActionButton {
            atlas: view.atlas
            width: parent.width
            text: "Dangling references"
            selected: atlas.findings.dangling === true
            onClicked: atlas.toggleFinding("dangling")
        }
        AtlasActionButton {
            atlas: view.atlas
            width: parent.width
            text: "Stale files"
            selected: atlas.findings.stale === true
            onClicked: atlas.toggleFinding("stale")
        }
        AtlasActionButton {
            atlas: view.atlas
            width: parent.width
            text: "Recently edited"
            selected: atlas.findings.recent === true
            onClicked: atlas.toggleFinding("recent")
        }
    }
    Column {
        visible: atlas.page === "details"
        width: parent.width
        spacing: Style.space(8)
        PanelSectionHeader {
            width: parent.width
            text: "FILE"
            foreground: atlas.bar ? atlas.bar.foreground : Color.foreground
            fontFamily: Style.font.family
        }
        Text {
            width: parent.width
            text: atlas.selectedFacts ? atlas.selectedFacts.file.title : "No file selected"
            textFormat: Text.PlainText
            color: Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            wrapMode: Text.WordWrap
        }
        Text {
            width: parent.width
            text: atlas.selectedFacts ? atlas.selectedFacts.file.root + "/" + atlas.selectedFacts.file.path + "\n" + IndexModel.kindLabel(atlas.index.kinds, atlas.selectedFacts.file.kind) + " · " + atlas.selectedFacts.file.time + " (" + atlas.selectedFacts.file.timeSource + ")\n" + atlas.selectedFacts.file.inbound + " inbound · " + atlas.selectedFacts.file.outbound + " outbound" : ""
            textFormat: Text.PlainText
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
        }
        Text {
            visible: atlas.selectedFacts && atlas.selectedFacts.stale
            width: parent.width
            text: atlas.selectedFacts && atlas.selectedFacts.stale ? "Stale: " + atlas.selectedFacts.stale.rule + " · newest " + atlas.selectedFacts.stale.newestSource.path + " at " + atlas.selectedFacts.stale.newestSource.time : ""
            textFormat: Text.PlainText
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
        }
        Repeater {
            model: atlas.selectedFacts ? atlas.selectedFacts.inboundGroups : []
            delegate: Text {
                required property var modelData
                width: parent.width
                text: "Inbound " + modelData.style + " · " + modelData.count + "\n" + modelData.references.map(function (reference) {
                    return reference.from.path + ":" + reference.line + " · " + reference.text;
                }).join("\n")
                textFormat: Text.PlainText
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
            }
        }
        Repeater {
            model: atlas.selectedFacts ? atlas.selectedFacts.outboundGroups : []
            delegate: Text {
                required property var modelData
                width: parent.width
                text: "Outbound " + modelData.style + " · " + modelData.count + "\n" + modelData.references.map(function (reference) {
                    return reference.resolved && reference.to ? reference.to.path : "missing · " + reference.text;
                }).join("\n")
                textFormat: Text.PlainText
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
            }
        }
        Repeater {
            model: atlas.selectedFacts ? atlas.selectedFacts.cost : []
            delegate: Text {
                required property var modelData
                width: parent.width
                text: modelData.agent + " · ~" + modelData.startupTokensApprox + " tokens at startup · ~" + modelData.referencedTokensApprox + " referenced"
                textFormat: Text.PlainText
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
        }
        Row {
            spacing: Style.space(6)
            AtlasActionButton {
                atlas: view.atlas
                text: "Read ↵"
                onClicked: atlas.readSelected()
            }
            AtlasActionButton {
                atlas: view.atlas
                text: "Map m"
                onClicked: atlas.showSelected(true, true)
            }
            AtlasActionButton {
                atlas: view.atlas
                text: "Edit e"
                onClicked: atlas.editSelected()
            }
        }
        AtlasActionButton {
            atlas: view.atlas
            text: "Copy path"
            onClicked: {
                copyPath.selectAll();
                copyPath.copy();
            }
        }
        TextField {
            id: copyPath
            visible: false
            text: atlas.selectedFacts ? atlas.selectedFacts.file.root + "/" + atlas.selectedFacts.file.path : ""
        }
    }
    Column {
        visible: atlas.page === "facts"
        width: parent.width
        spacing: Style.space(8)
        PanelSectionHeader {
            width: parent.width
            text: "FILE"
            foreground: atlas.bar ? atlas.bar.foreground : Color.foreground
            fontFamily: Style.font.family
        }
        Text {
            width: parent.width
            text: atlas.selectedFacts ? atlas.selectedFacts.file.title : "No file selected"
            textFormat: Text.PlainText
            color: Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            wrapMode: Text.WordWrap
        }
        Text {
            width: parent.width
            text: atlas.selectedFacts ? atlas.selectedFacts.file.root + "/" + atlas.selectedFacts.file.path : ""
            textFormat: Text.PlainText
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
        }
        Row {
            id: modificationRow
            width: parent.width
            spacing: Style.space(6)
            readonly property string state: atlas.selectedFacts ? IndexModel.recency(atlas.selectedFacts.file, atlas.recencyNow) : ""
            readonly property color recencyColour: state === "red" ? atlas.recencyRed : state === "orange" ? atlas.recencyOrange : Color.muted
            Text {
                text: atlas.selectedFacts ? atlas.selectedFacts.file.modified : ""
                textFormat: Text.PlainText
                color: modificationRow.recencyColour
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Text {
                text: atlas.selectedFacts ? IndexModel.relativeTime(atlas.selectedFacts.file, atlas.recencyNow) : ""
                textFormat: Text.PlainText
                color: modificationRow.recencyColour
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
        }
        Row {
            spacing: Style.space(6)
            AtlasActionButton {
                atlas: view.atlas
                text: "Read ↵"
                onClicked: atlas.readSelected()
            }
            AtlasActionButton {
                atlas: view.atlas
                text: "Map m"
                onClicked: atlas.showSelected(true, true)
            }
            AtlasActionButton {
                atlas: view.atlas
                text: "Edit e"
                onClicked: atlas.editSelected()
            }
            AtlasActionButton {
                atlas: view.atlas
                text: "Details d"
                onClicked: atlas.page = "details"
            }
        }
    }
}
