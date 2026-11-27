import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

export function getMaximizedFlags(win) {
    if (!win)
        return 0;
    if (typeof win.get_maximized === 'function')
        return win.get_maximized();
    if (typeof win.is_maximized === 'function' && win.is_maximized())
        return Meta.MaximizeFlags.BOTH;
    return 0;
}

export function maximizeWindow(win, flags = Meta.MaximizeFlags.BOTH) {
    if (!win)
        return;
    try {
        win.maximize(flags);
    } catch {
        win.maximize();
    }
}

export function unmaximizeWindow(win, flags = Meta.MaximizeFlags.BOTH) {
    if (!win)
        return;
    try {
        win.unmaximize(flags);
    } catch {
        win.unmaximize();
    }
}

/**
 * macOS-style three-finger titlebar window dragger.
 *
 * When a 3-finger gesture starts while the pointer is hovering over the title bar
 * of the topmost visible window, this controller smoothly drags the window (and
 * optionally keeps the cursor anchored to it) with support for maximized tear-off
 * and optional screen-edge snapping on release.
 */
export class WindowDragger {
    constructor(settings) {
        this._settings = settings;
        this._activeWindow = null;
        this._dragging = false;

        // Floating-point accumulators eliminate rounding jitter
        this._winX = 0;
        this._winY = 0;
        this._ptrX = 0;
        this._ptrY = 0;

        // Maximized tear-off state
        this._wasMaximized = false;
        this._tearAccumX = 0;
        this._tearAccumY = 0;
        this._pendingAnchorSync = false;
        this._anchorRatioX = 0.5;
        this._anchorOffsetY = 20;
        this._maximizedWidth = 0;
        this._unmaximizeStartedAt = 0;

        this._snapTimeoutId = 0;
    }

    get isDragging() {
        return this._dragging;
    }

    /**
     * Try to begin dragging a window under the current pointer.
     * Returns true if a draggable window titlebar (or window body if drag-anywhere)
     * was hit and drag mode is now active.
     */
    tryBeginDrag() {
        if (!this._settings.get_boolean('enable-titlebar-drag'))
            return false;

        if (Main.overview.visible || Main.sessionMode.isLocked)
            return false;

        const [px, py] = global.get_pointer();

        // Do not hijack gestures initiated on the GNOME top panel
        if (Main.panel && Main.panel.visible) {
            const [panelX, panelY] = Main.panel.get_transformed_position();
            const [panelW, panelH] = Main.panel.get_transformed_size();
            if (px >= panelX && px <= panelX + panelW && py >= panelY && py <= panelY + panelH)
                return false;
        }

        const target = this._findTopWindowAt(px, py);
        if (!target)
            return false;

        if (!target.allows_move() || target.is_fullscreen())
            return false;

        const rect = target.get_frame_rect();
        const dragAnywhere = this._settings.get_boolean('drag-anywhere');
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const titlebarHeight = this._settings.get_int('titlebar-height') * scaleFactor;

        if (!dragAnywhere) {
            const inTitlebar = py >= rect.y - 2 && py <= rect.y + titlebarHeight;
            if (!inTitlebar)
                return false;
        }

        // Focus & raise the window just like macOS three-finger drag
        target.activate(global.get_current_time());

        this._activeWindow = target;
        this._dragging = true;
        this._winX = rect.x;
        this._winY = rect.y;
        this._ptrX = px;
        this._ptrY = py;

        const maxFlags = getMaximizedFlags(target);
        this._wasMaximized = maxFlags !== 0;
        this._tearAccumX = 0;
        this._tearAccumY = 0;
        this._pendingAnchorSync = false;
        this._maximizedWidth = rect.width;
        this._anchorRatioX = clamp((px - rect.x) / Math.max(rect.width, 1), 0.1, 0.9);
        this._anchorOffsetY = clamp(py - rect.y, 8, Math.max(titlebarHeight, 24));

        this._setDragCursor(true);
        return true;
    }

    updateDrag(dx, dy) {
        if (!this._dragging || !this._activeWindow)
            return;

        // Guard against window closing mid-drag
        if (!this._activeWindow.get_compositor_private()) {
            this.endDrag(true);
            return;
        }

        const sensitivity = this._settings.get_double('drag-sensitivity');
        const stepX = dx * sensitivity;
        const stepY = dy * sensitivity;

        // Update virtual pointer position first
        const stageW = global.stage.width;
        const stageH = global.stage.height;
        this._ptrX = clamp(this._ptrX + stepX, 0, Math.max(stageW - 1, 0));
        this._ptrY = clamp(this._ptrY + stepY, 0, Math.max(stageH - 1, 0));

        if (this._settings.get_boolean('drag-follow-pointer'))
            this._warpPointer(this._ptrX, this._ptrY);

        // If window started maximized, wait until drag exceeds tear-off threshold
        if (this._wasMaximized) {
            this._tearAccumX += stepX;
            this._tearAccumY += stepY;
            const threshold = this._settings.get_int('drag-unmaximize-threshold');
            if (Math.hypot(this._tearAccumX, this._tearAccumY) < threshold)
                return;

            this._wasMaximized = false;
            this._pendingAnchorSync = true;
            this._unmaximizeStartedAt = GLib.get_monotonic_time();
            unmaximizeWindow(this._activeWindow, Meta.MaximizeFlags.BOTH);
            return;
        }

        // Wait for X11/client restored geometry after unmaximize, then anchor under cursor
        if (this._pendingAnchorSync) {
            const curRect = this._activeWindow.get_frame_rect();
            const elapsedUs = GLib.get_monotonic_time() - this._unmaximizeStartedAt;
            if (curRect.width < this._maximizedWidth - 20 || elapsedUs > 120000) {
                const workArea = this._getWorkAreaForPoint(this._ptrX, this._ptrY);
                this._winX = this._ptrX - curRect.width * this._anchorRatioX;
                this._winY = Math.max(workArea.y, this._ptrY - this._anchorOffsetY);
                this._pendingAnchorSync = false;
                this._activeWindow.move_frame(true, Math.round(this._winX), Math.round(this._winY));
            }
            return;
        }

        this._winX += stepX;
        this._winY += stepY;

        // Keep titlebar accessible below the top panel
        const workArea = this._getWorkAreaForPoint(this._ptrX, this._ptrY);
        const minY = workArea.y;
        if (this._winY < minY)
            this._winY = minY;

        this._activeWindow.move_frame(true, Math.round(this._winX), Math.round(this._winY));
    }

    endDrag(cancelled = false) {
        if (!this._dragging)
            return;

        const win = this._activeWindow;
        const ptrX = this._ptrX;
        const ptrY = this._ptrY;
        const wasStillMaximized = this._wasMaximized;

        this._dragging = false;
        this._activeWindow = null;
        this._pendingAnchorSync = false;
        this._setDragCursor(false);

        if (cancelled || !win || !win.get_compositor_private())
            return;

        if (!wasStillMaximized && this._settings.get_boolean('drag-edge-snap'))
            this._applyEdgeSnapIfNear(win, ptrX, ptrY);
    }

    destroy() {
        if (this._snapTimeoutId) {
            GLib.Source.remove(this._snapTimeoutId);
            this._snapTimeoutId = 0;
        }
        if (this._dragging) {
            this._dragging = false;
            this._activeWindow = null;
            this._setDragCursor(false);
        }
    }

    // ==================== Internal Helpers ====================

    _findTopWindowAt(px, py) {
        const workspace = global.workspace_manager.get_active_workspace();
        if (!workspace)
            return null;

        const candidates = workspace.list_windows().filter(win => {
            if (!win || win.minimized || !win.showing_on_its_workspace())
                return false;
            if (win.is_override_redirect())
                return false;
            const type = win.get_window_type();
            return (
                type === Meta.WindowType.NORMAL ||
                type === Meta.WindowType.DIALOG ||
                type === Meta.WindowType.MODAL_DIALOG ||
                type === Meta.WindowType.UTILITY
            );
        });

        // sort_windows_by_stacking returns bottom-to-top; iterate top-to-bottom
        const stacked = global.display.sort_windows_by_stacking(candidates);
        for (let i = stacked.length - 1; i >= 0; i--) {
            const win = stacked[i];
            const rect = win.get_frame_rect();
            if (px >= rect.x && px <= rect.x + rect.width &&
                py >= rect.y && py <= rect.y + rect.height) {
                return win;
            }
        }
        return null;
    }

    _getWorkAreaForPoint(px, py) {
        const monitorIndex = this._findMonitorIndexAt(px, py);
        const workspace = global.workspace_manager.get_active_workspace();
        if (workspace)
            return workspace.get_work_area_for_monitor(monitorIndex);
        return Main.layoutManager.monitors[monitorIndex] ?? { x: 0, y: 0, width: 1920, height: 1080 };
    }

    _findMonitorIndexAt(px, py) {
        const monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            const m = monitors[i];
            if (px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height)
                return i;
        }
        return Main.layoutManager.primaryIndex;
    }

    _applyEdgeSnapIfNear(win, px, py) {
        const monitorIdx = this._findMonitorIndexAt(px, py);
        const monitor = Main.layoutManager.monitors[monitorIdx];
        const workArea = this._getWorkAreaForPoint(px, py);
        if (!monitor || !workArea)
            return;

        const edgeMargin = 10;

        // Top edge -> maximize
        if (py <= workArea.y + edgeMargin && win.can_maximize()) {
            maximizeWindow(win, Meta.MaximizeFlags.BOTH);
            return;
        }

        // Left edge -> left half tile
        if (px <= monitor.x + edgeMargin && win.allows_resize()) {
            const halfW = Math.floor(workArea.width / 2);
            this._tileWindow(win, workArea.x, workArea.y, halfW, workArea.height);
            return;
        }

        // Right edge -> right half tile
        if (px >= monitor.x + monitor.width - edgeMargin && win.allows_resize()) {
            const halfW = Math.floor(workArea.width / 2);
            this._tileWindow(win, workArea.x + halfW, workArea.y, workArea.width - halfW, workArea.height);
        }
    }

    _tileWindow(win, x, y, w, h) {
        if (getMaximizedFlags(win) !== 0) {
            unmaximizeWindow(win, Meta.MaximizeFlags.BOTH);
            if (this._snapTimeoutId)
                GLib.Source.remove(this._snapTimeoutId);
            this._snapTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                this._snapTimeoutId = 0;
                if (win.get_compositor_private())
                    win.move_resize_frame(true, x, y, w, h);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            win.move_resize_frame(true, x, y, w, h);
        }
    }

    _warpPointer(x, y) {
        try {
            const seat = Clutter.get_default_backend().get_default_seat();
            seat?.warp_pointer(Math.round(x), Math.round(y));
        } catch {
            // Ignore if seat warp_pointer is unavailable
        }
    }

    _setDragCursor(active) {
        try {
            if (typeof global.display.set_cursor !== 'function' || !Meta.Cursor)
                return;
            if (active) {
                const cursor = Meta.Cursor.MOVE_OR_RESIZE_WINDOW ?? Meta.Cursor.DND_IN_DRAG ?? Meta.Cursor.DEFAULT;
                global.display.set_cursor(cursor);
            } else {
                global.display.set_cursor(Meta.Cursor.DEFAULT);
            }
        } catch {
            // Non-critical visual feedback
        }
    }
}
