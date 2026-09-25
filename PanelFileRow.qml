import QtQuick
import qs.Commons
import qs.Ui

CursorSurface {
    id: fileRow
    required property var atlas
    required property var file
    property string caption: ""
    width: parent.width
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX
    foreground: atlas.bar.foreground
    hasCursor: atlas.selectedRoot === file.root && atlas.selectedPath === file.path
    Column {
        id: rowContent
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.margins: Style.spacing.rowPaddingX
        spacing: Style.spacing.labelGap
        Text {
            width: parent.width
            text: fileRow.file.path
            textFormat: Text.PlainText
            color: atlas.bar.foreground
            font.family: atlas.bar.fontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.WrapAnywhere
        }
        Text {
            width: parent.width
            text: fileRow.caption
            textFormat: Text.PlainText
            color: Color.muted
            font.family: atlas.bar.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WrapAnywhere
        }
    }
    MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onEntered: atlas.selectFile(fileRow.file.root, fileRow.file.path)
        onClicked: {
            atlas.selectFile(fileRow.file.root, fileRow.file.path);
            atlas.readSelected();
        }
    }
}
