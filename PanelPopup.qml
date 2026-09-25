import QtQuick
import QtQuick.Window
import QtQuick.Controls as Controls
import qs.Commons
import qs.Ui
import "ui/IndexModel.js" as IndexModel

KeyboardPanel {
    id: view
    required property var atlas
    required property var anchorButton
    property alias keyCatcher: keyCatcher
    property alias searchField: content.searchField
    property alias pathField: content.pathField
    property alias searchRows: content.searchRows
    property alias fileRows: content.fileRows
    readonly property bool editingText: searchField.activeFocus || pathField.activeFocus || content.kindEditingText
    property bool returning: false
    function revealControl(item) {
        var point = item.mapToItem(content, 0, 0);
        if (point.y < listFlick.contentY)
            listFlick.contentY = point.y;
        else if (point.y + item.height > listFlick.contentY + listFlick.height)
            listFlick.contentY = point.y + item.height - listFlick.height;
    }
    function focusedControl() {
        var item = keyCatcher.Window.window.activeFocusItem;
        return item && item.enabled ? item : null;
    }
    function returnPressed() {
        var item = focusedControl();
        if (item && typeof item.activateControl === "function")
            item.activateControl();
        else if (atlas.page !== "roots" && atlas.page !== "kinds" && atlas.page !== "kind-editor")
            atlas.activateSelection();
    }
    function spacePressed() {
        var item = focusedControl();
        if (item && typeof item.activateControl === "function")
            item.activateControl();
        else if (atlas.page !== "roots" && atlas.page !== "kinds" && atlas.page !== "kind-editor")
            atlas.activateSelection();
    }
    anchorItem: anchorButton
    owner: atlas
    bar: atlas.bar
    open: atlas.opened
    focusTarget: keyCatcher
    contentWidth: view.fittedContentWidth(Style.space(380))
    contentHeight: view.fittedContentHeight(content.implicitHeight, Style.space(640))
    PanelKeyCatcher {
        id: keyCatcher
        anchors.fill: parent
        blocked: view.editingText
        Keys.forwardTo: [backKeyHandler]
        Item {
            id: backKeyHandler
            Keys.onPressed: event => {
                if (event.key === Qt.Key_Backspace && !view.editingText) {
                    atlas.goBack();
                    event.accepted = true;
                } else {
                    event.accepted = false;
                }
            }
        }
        onReturnRequested: {
            view.returning = true;
            view.returnPressed();
        }
        onActivateRequested: {
            if (view.returning) {
                view.returning = false;
                return;
            }
            view.spacePressed();
        }
        onMoveRequested: function (dx, dy) {
            if (dx > 0 && atlas.page !== "files")
                view.spacePressed();
            if (dx < 0)
                atlas.goBack();
            else if (dx > 0 && atlas.page === "files" && atlas.selectedFacts)
                atlas.openFacts(atlas.selectedRoot, atlas.selectedPath);
            if (dy !== 0)
                atlas.moveSelection(dy);
        }
        onDeleteRequested: atlas.goBack()
        onCloseRequested: atlas.closeFromEscape()
        onTabRequested: function (direction) {
            atlas.moveRootsFocus(direction > 0);
        }
        onTextKey: function (text) {
            var key = String(text).toLowerCase();
            if (key === "backspace" || key === "h" || key === "left")
                atlas.goBack();
            else if (key === "/" && !atlas.settingsPage)
                searchField.forceActiveFocus();
            else if ((key === "l" || key === "right") && atlas.page !== "files")
                view.spacePressed();
            else if ((key === "l" || key === "right") && atlas.page === "files" && atlas.selectedFacts)
                atlas.openFacts(atlas.selectedRoot, atlas.selectedPath);
            else if (key === "d" && atlas.selectedFacts)
                atlas.openFacts(atlas.selectedRoot, atlas.selectedPath);
            else if (key === "o")
                atlas.readSelected();
            else if (key === "m")
                atlas.showSelected(true, true);
            else if (key === "e")
                atlas.editSelected();
            else if (key === "r")
                atlas.retryFailure(IndexModel.failureCommand(atlas.refreshError, atlas.searchError, atlas.costError));
        }
        Flickable {
            id: listFlick
            anchors.fill: parent
            contentWidth: width
            contentHeight: content.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            flickableDirection: Flickable.VerticalFlick
            interactive: contentHeight > height
            Controls.ScrollBar.vertical: Controls.ScrollBar {
                policy: Controls.ScrollBar.AsNeeded
            }
            PanelContent {
                id: content
                atlas: view.atlas
            }
        }
    }
}
