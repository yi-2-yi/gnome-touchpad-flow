import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { getTranslations } from './i18n.js';
import { getMaximizedFlags, maximizeWindow, unmaximizeWindow } from './windowDragger.js';

/**
 * Executes customizable swipe gesture actions on GNOME Shell 48+.
 */
export class ActionRunner {
    constructor(settings) {
        this._settings = settings;
        this._virtualKeyboard = null;
        this._desktopHiddenWindows = [];
        this._tileTimeoutId = 0;
        this._overviewRetryTimeoutId = 0;
    }

    run(actionId, customCommand = '') {
        if (!actionId || actionId === 'none')
            return;

        try {
            switch (actionId) {
                case 'open-overview-or-apps':
                    this._openOverviewOrApps();
                    break;
                case 'close-overview-or-desktop':
                    this._closeOverviewOrDesktop();
                    break;
                case 'toggle-overview':
                    this._toggleOverview();
                    break;
                case 'toggle-app-grid':
                    this._toggleAppGrid();
                    break;
                case 'workspace-next':
                    this._switchWorkspace(1);
                    break;
                case 'workspace-prev':
                    this._switchWorkspace(-1);
                    break;
                case 'move-window-workspace-next':
                    this._moveWindowToWorkspace(1);
                    break;
                case 'move-window-workspace-prev':
                    this._moveWindowToWorkspace(-1);
                    break;
                case 'switch-window-next':
                    this._cycleWindow(1);
                    break;
                case 'switch-window-prev':
                    this._cycleWindow(-1);
                    break;
                case 'toggle-maximize':
                    this._toggleMaximize();
                    break;
                case 'minimize-window':
                    this._minimizeFocused();
                    break;
                case 'close-window':
                    this._closeFocused();
                    break;
                case 'tile-left':
                    this._tileFocused('left');
                    break;
                case 'tile-right':
                    this._tileFocused('right');
                    break;
                case 'toggle-fullscreen':
                    this._toggleFullscreen();
                    break;
                case 'show-desktop':
                    this._toggleShowDesktop();
                    break;
                case 'browser-back':
                    this._sendKeyCombo([Clutter.KEY_Alt_L], Clutter.KEY_Left);
                    break;
                case 'browser-forward':
                    this._sendKeyCombo([Clutter.KEY_Alt_L], Clutter.KEY_Right);
                    break;
                case 'volume-up':
                    this._sendKeyCombo([], Clutter.KEY_AudioRaiseVolume ?? 0x1008ff13);
                    break;
                case 'volume-down':
                    this._sendKeyCombo([], Clutter.KEY_AudioLowerVolume ?? 0x1008ff11);
                    break;
                case 'volume-mute':
                    this._sendKeyCombo([], Clutter.KEY_AudioMute ?? 0x1008ff12);
                    break;
                case 'media-play-pause':
                    this._sendKeyCombo([], Clutter.KEY_AudioPlay ?? 0x1008ff14);
                    break;
                case 'screenshot-ui':
                    this._openScreenshotUI();
                    break;
                case 'custom-command':
                    this._runCustomCommand(customCommand);
                    break;
                default:
                    console.warn(`[TouchpadFlow] Unknown action: ${actionId}`);
                    return;
            }

            if (this._settings.get_boolean('show-osd-feedback'))
                this._showOsd(actionId);
        } catch (err) {
            console.error(`[TouchpadFlow] Action "${actionId}" failed: ${err}`);
        }
    }

    destroy() {
        if (this._tileTimeoutId) {
            GLib.Source.remove(this._tileTimeoutId);
            this._tileTimeoutId = 0;
        }
        if (this._overviewRetryTimeoutId) {
            GLib.Source.remove(this._overviewRetryTimeoutId);
            this._overviewRetryTimeoutId = 0;
        }
        this._virtualKeyboard = null;
        this._desktopHiddenWindows = [];
    }

    // ==================== Overview & App Grid ====================

    _ensureOverviewOpened(showApps = false) {
        if (this._overviewRetryTimeoutId) {
            GLib.Source.remove(this._overviewRetryTimeoutId);
            this._overviewRetryTimeoutId = 0;
        }

        const trigger = () => {
            if (showApps) {
                if (typeof Main.overview.showApps === 'function')
                    Main.overview.showApps();
                else {
                    Main.overview.show();
                    if (Main.overview.dash?.showAppsButton)
                        Main.overview.dash.showAppsButton.checked = true;
                }
            } else {
                Main.overview.show();
            }
        };

        trigger();

        // Safety retry once after 60ms if X11 grab release took an extra frame
        this._overviewRetryTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._overviewRetryTimeoutId = 0;
            if (!Main.overview.visible && !Main.overview.visibleTarget)
                trigger();
            return GLib.SOURCE_REMOVE;
        });
    }

    _toggleOverview() {
        if (Main.overview.visible)
            Main.overview.hide();
        else
            this._ensureOverviewOpened(false);
    }

    _openOverviewOrApps() {
        if (!Main.overview.visible) {
            this._ensureOverviewOpened(false);
        } else if (!this._isAppGridVisible()) {
            this._ensureOverviewOpened(true);
        }
    }

    _closeOverviewOrDesktop() {
        if (Main.overview.visible) {
            if (this._isAppGridVisible() && Main.overview.dash?.showAppsButton)
                Main.overview.dash.showAppsButton.checked = false;
            else
                Main.overview.hide();
        } else {
            this._toggleShowDesktop();
        }
    }

    _toggleAppGrid() {
        if (Main.overview.visible && this._isAppGridVisible())
            Main.overview.hide();
        else
            this._ensureOverviewOpened(true);
    }

    _isAppGridVisible() {
        return Boolean(Main.overview.dash?.showAppsButton?.checked);
    }

    // ==================== Workspaces ====================

    _switchWorkspace(delta) {
        const wm = global.workspace_manager;
        const activeIdx = wm.get_active_workspace_index();
        const targetIdx = activeIdx + delta;

        if (targetIdx < 0 || targetIdx >= wm.n_workspaces)
            return;

        const targetWs = wm.get_workspace_by_index(targetIdx);
        if (!targetWs)
            return;

        if (typeof Main.wm.actionMoveWorkspace === 'function')
            Main.wm.actionMoveWorkspace(targetWs);
        else
            targetWs.activate(global.get_current_time());
    }

    _moveWindowToWorkspace(delta) {
        const win = this._getFocusedNormalWindow();
        if (!win)
            return;

        const wm = global.workspace_manager;
        const activeIdx = wm.get_active_workspace_index();
        const targetIdx = activeIdx + delta;

        if (targetIdx < 0 || targetIdx >= wm.n_workspaces)
            return;

        const targetWs = wm.get_workspace_by_index(targetIdx);
        if (!targetWs)
            return;

        win.change_workspace(targetWs);
        if (typeof Main.wm.actionMoveWorkspace === 'function')
            Main.wm.actionMoveWorkspace(targetWs);
        else
            targetWs.activate(global.get_current_time());
    }

    // ==================== Window Management ====================

    _getFocusedNormalWindow() {
        const win = global.display.focus_window;
        if (!win || win.is_override_redirect())
            return null;
        const type = win.get_window_type();
        if (type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK)
            return null;
        return win;
    }

    _cycleWindow(delta) {
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws)
            return;

        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, ws)
            .filter(w => !w.skip_taskbar);

        if (windows.length < 2)
            return;

        const focused = global.display.focus_window;
        const idx = windows.indexOf(focused);
        let nextIdx;
        if (idx === -1)
            nextIdx = 0;
        else
            nextIdx = (idx + delta + windows.length) % windows.length;

        const nextWin = windows[nextIdx];
        if (nextWin) {
            if (nextWin.minimized)
                nextWin.unminimize();
            nextWin.activate(global.get_current_time());
        }
    }

    _toggleMaximize() {
        const win = this._getFocusedNormalWindow();
        if (!win || !win.can_maximize())
            return;

        if (getMaximizedFlags(win) === Meta.MaximizeFlags.BOTH)
            unmaximizeWindow(win, Meta.MaximizeFlags.BOTH);
        else
            maximizeWindow(win, Meta.MaximizeFlags.BOTH);
    }

    _minimizeFocused() {
        const win = this._getFocusedNormalWindow();
        if (!win || !win.can_minimize())
            return;
        win.minimize();
    }

    _closeFocused() {
        const win = this._getFocusedNormalWindow();
        if (!win || !win.can_close())
            return;
        win.delete(global.get_current_time());
    }

    _toggleFullscreen() {
        const win = this._getFocusedNormalWindow();
        if (!win)
            return;
        if (win.is_fullscreen())
            win.unmake_fullscreen();
        else
            win.make_fullscreen();
    }

    _tileFocused(side) {
        const win = this._getFocusedNormalWindow();
        if (!win || !win.allows_resize() || !win.allows_move())
            return;

        if (win.is_fullscreen())
            win.unmake_fullscreen();

        const monitorIdx = win.get_monitor();
        const ws = win.get_workspace();
        const workArea = ws
            ? ws.get_work_area_for_monitor(monitorIdx)
            : Main.layoutManager.monitors[monitorIdx];
        if (!workArea)
            return;

        const halfW = Math.floor(workArea.width / 2);
        const x = side === 'left' ? workArea.x : workArea.x + halfW;
        const w = side === 'left' ? halfW : workArea.width - halfW;

        if (getMaximizedFlags(win) !== 0) {
            unmaximizeWindow(win, Meta.MaximizeFlags.BOTH);
            if (this._tileTimeoutId)
                GLib.Source.remove(this._tileTimeoutId);
            this._tileTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                this._tileTimeoutId = 0;
                if (win.get_compositor_private())
                    win.move_resize_frame(true, x, workArea.y, w, workArea.height);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            win.move_resize_frame(true, x, workArea.y, w, workArea.height);
        }
    }

    _toggleShowDesktop() {
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws)
            return;

        const visibleWindows = ws.list_windows().filter(w => {
            if (!w || w.minimized || w.skip_taskbar || w.is_override_redirect())
                return false;
            const type = w.get_window_type();
            return type === Meta.WindowType.NORMAL || type === Meta.WindowType.DIALOG;
        });

        if (visibleWindows.length > 0) {
            this._desktopHiddenWindows = visibleWindows;
            for (const w of visibleWindows) {
                if (w.can_minimize())
                    w.minimize();
            }
        } else if (this._desktopHiddenWindows.length > 0) {
            const toRestore = this._desktopHiddenWindows.slice();
            this._desktopHiddenWindows = [];
            for (const w of toRestore) {
                try {
                    if (w.get_compositor_private() && w.minimized)
                        w.unminimize();
                } catch {
                    // Window may have been closed
                }
            }
        }
    }

    // ==================== Virtual Keyboard & System Actions ====================

    _getVirtualKeyboard() {
        if (!this._virtualKeyboard) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._virtualKeyboard = seat?.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE
            ) ?? null;
        }
        return this._virtualKeyboard;
    }

    _sendKeyCombo(modifiers, keyval) {
        const vkbd = this._getVirtualKeyboard();
        if (!vkbd || !keyval)
            return;

        const now = GLib.get_monotonic_time();
        for (const mod of modifiers)
            vkbd.notify_keyval(now, mod, Clutter.KeyState.PRESSED);

        vkbd.notify_keyval(now, keyval, Clutter.KeyState.PRESSED);
        vkbd.notify_keyval(now, keyval, Clutter.KeyState.RELEASED);

        for (let i = modifiers.length - 1; i >= 0; i--)
            vkbd.notify_keyval(now, modifiers[i], Clutter.KeyState.RELEASED);
    }

    _openScreenshotUI() {
        if (Main.screenshotUI && typeof Main.screenshotUI.open === 'function')
            Main.screenshotUI.open();
        else
            this._sendKeyCombo([], Clutter.KEY_Print);
    }

    _runCustomCommand(command) {
        const trimmed = (command || '').trim();
        if (!trimmed)
            return;

        try {
            const proc = new Gio.Subprocess({
                argv: ['/bin/sh', '-c', trimmed],
                flags: Gio.SubprocessFlags.NONE,
            });
            proc.init(null);
        } catch (err) {
            console.error(`[TouchpadFlow] Custom command failed ("${trimmed}"): ${err}`);
        }
    }

    _showOsd(actionId) {
        try {
            const lang = this._settings.get_string('ui-language');
            const t = getTranslations(lang);
            const label = t.actions[actionId] || actionId;
            const icon = Gio.ThemedIcon.new('input-touchpad-symbolic');
            const monitor = Main.layoutManager.currentMonitor?.index ?? Main.layoutManager.primaryIndex;
            Main.osdWindowManager.show(monitor, icon, label);
        } catch {
            // OSD is optional
        }
    }
}
