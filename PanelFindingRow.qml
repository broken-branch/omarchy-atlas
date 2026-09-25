import QtQuick
import qs.Commons
import qs.Ui

CursorSurface {
    id: findingRow
    required property var atlas
    required property int position
    property string label: ""
    property string value: ""
    signal clicked
    width: parent.width
    implicitHeight: Math.max(findingLabel.implicitHeight, findingValue.implicitHeight) + Style.spacing.rowPaddingX
    foreground: atlas.bar.foreground
    hasCursor: atlas.selectedFinding === position
    Text {
        id: findingLabel
        anchors.left: parent.left
        anchors.right: findingValue.left
        anchors.leftMargin: Style.spacing.rowPaddingX
        anchors.rightMargin: Style.spacing.labelGap
        anchors.verticalCenter: parent.verticalCenter
        text: findingRow.label
        textFormat: Text.PlainText
        color: atlas.bar.foreground
        font.family: atlas.bar.fontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.WordWrap
    }
    Text {
        id: findingValue
        anchors.right: parent.right
        anchors.rightMargin: Style.spacing.rowPaddingX
        anchors.verticalCenter: parent.verticalCenter
        text: findingRow.value
        textFormat: Text.PlainText
        color: Color.muted
        font.family: atlas.bar.fontFamily
        font.pixelSize: Style.font.caption
        horizontalAlignment: Text.AlignRight
    }
    MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onEntered: atlas.selectedFinding = findingRow.position
        onClicked: {
            atlas.selectedFinding = findingRow.position;
            findingRow.clicked();
        }
    }
}
