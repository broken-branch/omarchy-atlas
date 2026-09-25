import QtQuick
import qs.Commons
import qs.Ui

Column {
    id: view
    required property var atlas
    property alias pathField: pathField
    visible: atlas.page === "roots"
    width: parent.width
    spacing: Style.space(8)
    PanelSectionHeader {
        width: parent.width
        text: "ROOTS"
        foreground: atlas.bar.foreground
        fontFamily: atlas.bar.fontFamily
    }
    Text {
        visible: atlas.registeredRoots.length === 0
        text: "No roots registered"
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.body
    }
    Repeater {
        model: atlas.registeredRoots
        delegate: CursorSurface {
            required property var modelData
            width: parent.width
            implicitHeight: Math.max(rootLabel.implicitHeight, removeRoot.height) + Style.spacing.rowPaddingX
            foreground: atlas.bar.foreground
            hasCursor: removeRoot.activeFocus
            Text {
                id: rootLabel
                anchors.left: parent.left
                anchors.right: removeRoot.left
                anchors.margins: Style.spacing.rowPaddingX
                anchors.verticalCenter: parent.verticalCenter
                text: modelData.name + "\n" + modelData.path
                textFormat: Text.PlainText
                color: Color.foreground
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                wrapMode: Text.WrapAnywhere
            }
            AtlasActionButton {
                id: removeRoot
                atlas: view.atlas
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                text: "Remove"
                activeFocusOnTab: true
                enabled: !atlas.rootsBusy
                onClicked: atlas.changeRoot("root-remove", modelData.name)
            }
        }
    }
    AtlasActionButton {
        atlas: view.atlas
        text: "Whole system"
        activeFocusOnTab: true
        enabled: !atlas.rootsBusy
        onClicked: atlas.changeRoot("root-add", "/")
    }
    AtlasActionButton {
        atlas: view.atlas
        text: "A drive"
        activeFocusOnTab: true
        enabled: !atlas.drivesLoading
        onClicked: atlas.loadDrives()
    }
    Text {
        visible: atlas.showDrives && (atlas.drivesLoading || atlas.drivesError !== "" || atlas.drives.length === 0)
        width: parent.width
        text: atlas.drivesLoading ? "Reading mounted drives…" : atlas.drivesError || "No real filesystems mounted."
        textFormat: Text.PlainText
        color: atlas.drivesError ? Color.urgent : Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
    }
    Repeater {
        model: atlas.showDrives ? atlas.drives : []
        delegate: CursorSurface {
            id: driveRow
            function activateControl() {
                atlas.changeRoot("root-add", modelData.target);
            }
            required property var modelData
            width: parent.width
            implicitHeight: driveLabel.implicitHeight + Style.spacing.rowPaddingX
            foreground: atlas.bar.foreground
            hasCursor: activeFocus
            activeFocusOnTab: true
            onActiveFocusChanged: if (activeFocus)
                atlas.revealControl(driveRow)
            enabled: !atlas.rootsBusy
            Keys.onReturnPressed: activateControl()
            Keys.onEnterPressed: activateControl()
            Keys.onSpacePressed: activateControl()
            Text {
                id: driveLabel
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.margins: Style.spacing.rowPaddingX
                anchors.verticalCenter: parent.verticalCenter
                text: driveRow.modelData.target + "\n" + driveRow.modelData.source + " · " + driveRow.modelData.fstype
                textFormat: Text.PlainText
                color: Color.foreground
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                wrapMode: Text.WrapAnywhere
            }
            MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onEntered: driveRow.forceActiveFocus()
                onClicked: atlas.changeRoot("root-add", driveRow.modelData.target)
            }
        }
    }
    Text {
        text: "A path"
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.body
    }
    TextField {
        id: pathField
        onActiveFocusChanged: if (activeFocus)
            atlas.revealControl(pathField)
        width: parent.width
        placeholderText: "/path/to/directory"
        enabled: !atlas.rootsBusy
        onAccepted: atlas.changeRoot("root-add", text)
        Keys.onEscapePressed: atlas.focusPopup()
    }
    AtlasActionButton {
        atlas: view.atlas
        text: "Add path ↵"
        activeFocusOnTab: true
        enabled: !atlas.rootsBusy && pathField.text.length > 0
        onClicked: atlas.changeRoot("root-add", pathField.text)
    }
    Text {
        visible: atlas.rootsBusy || atlas.rootsError !== ""
        width: parent.width
        text: atlas.rootsBusy ? "Saving roots…" : atlas.rootsError
        textFormat: Text.PlainText
        color: atlas.rootsError ? Color.urgent : Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
    }
}
