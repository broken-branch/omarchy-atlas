import QtQuick
import qs.Commons
import qs.Ui
import "ui/IndexModel.js" as IndexModel

CursorSurface {
    id: row
    required property var atlas
    required property var kind
    property bool selected: false
    signal clicked
    function activateControl() {
        clicked();
    }
    width: parent.width
    implicitHeight: label.implicitHeight + Style.spacing.rowPaddingX
    foreground: atlas.bar.foreground
    hasCursor: activeFocus || selected
    activeFocusOnTab: true
    onActiveFocusChanged: if (activeFocus)
        atlas.revealControl(row)
    Keys.onReturnPressed: activateControl()
    Keys.onEnterPressed: activateControl()
    Keys.onSpacePressed: activateControl()
    Rectangle {
        id: dot
        anchors.left: parent.left
        anchors.leftMargin: Style.spacing.rowPaddingX
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(8)
        height: width
        radius: width / 2
        color: atlas.kindColour(row.kind.colour)
    }
    Text {
        id: label
        anchors.left: dot.right
        anchors.right: parent.right
        anchors.margins: Style.spacing.rowPaddingX
        anchors.verticalCenter: parent.verticalCenter
        text: row.kind.label + " · " + row.kind.count + "\n" + IndexModel.kindRule(row.kind) + " · " + IndexModel.kindTypes(row.kind)
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
        onEntered: row.forceActiveFocus()
        onClicked: row.clicked()
    }
}
