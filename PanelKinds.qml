import QtQuick
import QtQuick.Controls as Controls
import qs.Commons
import qs.Ui
import "ui/IndexModel.js" as IndexModel
import "PanelBridge.js" as PanelBridge

Column {
    id: view
    required property var atlas
    readonly property bool editing: atlas.page === "kind-editor"
    readonly property bool editingText: idField.activeFocus || labelField.activeFocus || pathsField.activeFocus || extensionsField.activeFocus
    property string chosenColour: atlas.kindDraft.colour || "accent"
    function save() {
        atlas.changeKind("kind-set", {
            id: idField.text,
            label: labelField.text,
            colour: chosenColour,
            paths: pathsField.text,
            extensions: extensionsField.text,
            builtin: atlas.kindDraft.builtin,
            adding: atlas.kindDraft.adding
        });
    }
    Connections {
        target: atlas
        function onKindDraftChanged() {
            view.chosenColour = atlas.kindDraft.colour || "accent";
        }
    }
    visible: atlas.page === "kinds" || editing
    width: parent.width
    spacing: Style.space(8)
    PanelSectionHeader {
        width: parent.width
        text: view.editing ? (atlas.kindDraft.adding ? "ADD KIND" : "EDIT KIND") : "KINDS"
        foreground: atlas.bar.foreground
        fontFamily: atlas.bar.fontFamily
    }
    Column {
        visible: !view.editing
        width: parent.width
        spacing: Style.space(8)
        Repeater {
            model: IndexModel.kindOptions({
                kinds: atlas.kindTable,
                files: atlas.index.files
            })
            delegate: PanelKindRow {
                required property var modelData
                atlas: view.atlas
                kind: modelData
                enabled: !atlas.kindsBusy
                onClicked: atlas.editKind(modelData)
            }
        }
        AtlasActionButton {
            atlas: view.atlas
            text: "Add kind"
            activeFocusOnTab: true
            enabled: !atlas.kindsBusy
            onClicked: atlas.editKind(null)
        }
    }
    Column {
        visible: view.editing
        width: parent.width
        spacing: Style.space(8)
        enabled: !atlas.kindsBusy
        Text {
            text: "Id"
            color: Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.body
        }
        TextField {
            id: idField
            width: parent.width
            text: atlas.kindDraft.id || ""
            readOnly: !atlas.kindDraft.adding
            placeholderText: "kind-id"
            onActiveFocusChanged: if (activeFocus)
                atlas.revealControl(idField)
            onAccepted: labelField.forceActiveFocus()
            Keys.onEscapePressed: atlas.focusPopup()
        }
        Text {
            visible: atlas.kindsError !== "" && atlas.kindsErrorField === "id"
            width: parent.width
            text: atlas.kindsError
            textFormat: Text.PlainText
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WrapAnywhere
        }
        Text {
            text: "Label"
            color: Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.body
        }
        TextField {
            id: labelField
            width: parent.width
            text: atlas.kindDraft.label || ""
            onActiveFocusChanged: if (activeFocus)
                atlas.revealControl(labelField)
            onAccepted: view.save()
            Keys.onEscapePressed: atlas.focusPopup()
        }
        Text {
            visible: atlas.kindsError !== "" && atlas.kindsErrorField === "label"
            width: parent.width
            text: atlas.kindsError
            textFormat: Text.PlainText
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WrapAnywhere
        }
        Text {
            text: "Colour · " + view.chosenColour
            textFormat: Text.PlainText
            color: Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.body
        }
        Flow {
            width: parent.width
            spacing: Style.space(6)
            Repeater {
                model: PanelBridge.KIND_COLOURS.concat((atlas.kindDraft.colour || "").charAt(0) === "#" ? [atlas.kindDraft.colour] : [])
                delegate: AtlasActionButton {
                    id: colourButton
                    required property string modelData
                    atlas: view.atlas
                    text: "●"
                    foreground: atlas.kindColour(modelData)
                    tooltipText: modelData
                    Accessible.name: modelData
                    activeFocusOnTab: true
                    selected: view.chosenColour === modelData
                    onClicked: view.chosenColour = modelData
                }
            }
        }
        Text {
            visible: atlas.kindsError !== "" && atlas.kindsErrorField === "colour"
            width: parent.width
            text: atlas.kindsError
            textFormat: Text.PlainText
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WrapAnywhere
        }
        Text {
            text: "Paths · one per line; empty means any path"
            width: parent.width
            color: Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
        }
        Controls.TextArea {
            id: pathsField
            width: parent.width
            text: atlas.kindDraft.paths || ""
            placeholderText: "docs/\n*.txt"
            color: Color.foreground
            selectionColor: Color.accent
            selectedTextColor: Color.background
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            wrapMode: TextEdit.WrapAnywhere
            activeFocusOnTab: true
            onActiveFocusChanged: if (activeFocus)
                atlas.revealControl(pathsField)
            Keys.onEscapePressed: atlas.focusPopup()
            Keys.onTabPressed: atlas.moveRootsFocus(true)
            Keys.onBacktabPressed: atlas.moveRootsFocus(false)
            background: Rectangle {
                color: Color.background
                border.color: pathsField.activeFocus ? Color.accent : Color.muted
                border.width: 1
            }
        }
        Text {
            visible: atlas.kindsError !== "" && atlas.kindsErrorField === "paths"
            width: parent.width
            text: atlas.kindsError
            textFormat: Text.PlainText
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WrapAnywhere
        }
        Text {
            text: "Extensions · one per line; empty means any type"
            width: parent.width
            color: Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
        }
        Controls.TextArea {
            id: extensionsField
            width: parent.width
            text: atlas.kindDraft.extensions || ""
            placeholderText: ".txt\n.json"
            color: Color.foreground
            selectionColor: Color.accent
            selectedTextColor: Color.background
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            wrapMode: TextEdit.WrapAnywhere
            activeFocusOnTab: true
            onActiveFocusChanged: if (activeFocus)
                atlas.revealControl(extensionsField)
            Keys.onEscapePressed: atlas.focusPopup()
            Keys.onTabPressed: atlas.moveRootsFocus(true)
            Keys.onBacktabPressed: atlas.moveRootsFocus(false)
            background: Rectangle {
                color: Color.background
                border.color: extensionsField.activeFocus ? Color.accent : Color.muted
                border.width: 1
            }
        }
        Text {
            visible: atlas.kindsError !== "" && atlas.kindsErrorField === "extensions"
            width: parent.width
            text: atlas.kindsError
            textFormat: Text.PlainText
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WrapAnywhere
        }
        AtlasActionButton {
            atlas: view.atlas
            text: "Save"
            activeFocusOnTab: true
            onClicked: view.save()
        }
        AtlasActionButton {
            atlas: view.atlas
            visible: !atlas.kindDraft.adding
            text: atlas.kindDraft.builtin ? "Reset to default" : "Remove"
            enabled: !atlas.kindDraft.builtin || atlas.kindDraft.overridden === true
            activeFocusOnTab: true
            onClicked: atlas.changeKind("kind-remove", atlas.kindDraft)
        }
    }
    Text {
        visible: atlas.kindsBusy || (atlas.kindsError !== "" && (!view.editing || atlas.kindsErrorField === "save"))
        width: parent.width
        text: atlas.kindsBusy ? "Saving kinds…" : atlas.kindsError
        textFormat: Text.PlainText
        color: atlas.kindsError ? Color.urgent : Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        wrapMode: Text.WrapAnywhere
    }
}
