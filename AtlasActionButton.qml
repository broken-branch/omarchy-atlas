import QtQuick
import qs.Commons
import qs.Ui

Button {
    id: actionButton
    required property var atlas
    function activateControl() {
        clicked();
    }
    onActiveFocusChanged: if (activeFocus)
        atlas.revealControl(actionButton)
    foreground: atlas.bar.foreground
    fontFamily: atlas.bar.fontFamily
    fontSize: Style.font.bodySmall
    bordered: true
}
