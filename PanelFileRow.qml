import QtQuick
import qs.Commons
import qs.Ui
import "ui/IndexModel.js" as IndexModel

CursorSurface {
    id: fileRow
    required property var atlas
    required property var file
    property string caption: ""
    property int searchRowIndex: -1
    readonly property string recency: IndexModel.recency(file, atlas.recencyNow)
    readonly property string recencyText: IndexModel.recencyText(file, atlas.recencyNow)
    width: parent.width
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX
    foreground: atlas.bar.foreground
    hasCursor: atlas.selectedRoot === file.root && atlas.selectedPath === file.path && (!atlas.query || searchRowIndex === atlas.selectedSearchRow)
    Accessible.role: Accessible.Button
    Accessible.name: file.path
    Accessible.description: [caption, recencyText].filter(Boolean).join(" · ")
    Rectangle {
        id: recencyDot
        width: Style.space(7)
        height: width
        radius: width / 2
        anchors.left: parent.left
        anchors.leftMargin: Style.spacing.rowPaddingX
        anchors.verticalCenter: parent.verticalCenter
        visible: fileRow.recency !== ""
        color: fileRow.recency === "red" ? atlas.recencyRed : atlas.recencyOrange
        Accessible.role: Accessible.StaticText
        Accessible.name: fileRow.recencyText
        Accessible.description: fileRow.recencyText
    }
    Column {
        id: rowContent
        anchors.left: recencyDot.right
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
        onEntered: {
            if (fileRow.searchRowIndex >= 0)
                atlas.selectedSearchRow = fileRow.searchRowIndex;
            atlas.selectFile(fileRow.file.root, fileRow.file.path);
        }
        onClicked: {
            if (fileRow.searchRowIndex >= 0)
                atlas.selectedSearchRow = fileRow.searchRowIndex;
            atlas.selectFile(fileRow.file.root, fileRow.file.path);
            atlas.readSelected();
        }
    }
}
