import GLib from 'gi://GLib';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ActionRunner } from './lib/actionRunner.js';
import { GestureBackend } from './lib/gestureBackend.js';
import { getLocalizedErrorMessage, getTranslations } from './lib/i18n.js';
import { WindowDragger } from './lib/windowDragger.js';

export default class TouchpadFlowExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._dragger = new WindowDragger(this._settings);
        this._actions = new ActionRunner(this._settings);

        this._accumX = 0;
        this._accumY = 0;
        this._activeFingers = 0;
        this._activeMode = 'none'; // 'none' | 'drag' | 'swipe'
        this._pendingActionTimeoutId = 0;
        this._notifiedError = false;

        this._backend = new GestureBackend(this.dir, {
            onSwipeBegin: fingers => this._onSwipeBegin(fingers),
            onSwipeUpdate: (fingers, dx, dy) => this._onSwipeUpdate(fingers, dx, dy),
            onSwipeEnd: (fingers, cancelled) => this._onSwipeEnd(fingers, cancelled),
            onStatus: status => this._onBackendStatus(status),
        });
        this._backend.start();
    }

    disable() {
        this._cancelPendingAction();

        if (this._backend) {
            this._backend.destroy();
            this._backend = null;
        }
        if (this._dragger) {
            this._dragger.destroy();
            this._dragger = null;
        }
        if (this._actions) {
            this._actions.destroy();
            this._actions = null;
        }
        this._settings = null;
        this._resetGestureState();
    }

    _resetGestureState() {
        this._accumX = 0;
        this._accumY = 0;
        this._activeFingers = 0;
        this._activeMode = 'none';
    }

    _cancelPendingAction() {
        if (this._pendingActionTimeoutId) {
            GLib.Source.remove(this._pendingActionTimeoutId);
            this._pendingActionTimeoutId = 0;
        }
    }

    _onSwipeBegin(fingers) {
        this._resetGestureState();

        if (!this._settings || Main.sessionMode.isLocked)
            return false;

        this._activeFingers = fingers;

        // 1. Priority: Three-finger drag on a window title bar (macOS style)
        if (fingers === 3 && this._dragger.tryBeginDrag()) {
            this._activeMode = 'drag';
            return true;
        }

        // 2. Fallback: Three-finger or four-finger customizable directional swipes
        if (fingers === 3 && this._settings.get_boolean('enable-three-finger-swipe')) {
            this._activeMode = 'swipe';
            return true;
        }

        if (fingers === 4 && this._settings.get_boolean('enable-four-finger-swipe')) {
            this._activeMode = 'swipe';
            return true;
        }

        return false;
    }

    _onSwipeUpdate(_fingers, dx, dy) {
        if (!this._settings)
            return;

        if (this._activeMode === 'drag') {
            this._dragger.updateDrag(dx, dy);
            return;
        }

        if (this._activeMode !== 'swipe')
            return;

        // Accumulate full swipe delta; action fires on swipe_end AFTER X11 releases
        // the active XIGrabSwipeGestureBegin grab (required so Main.overview.show()
        // and other modal GNOME actions do not collide with AlreadyGrabbed).
        this._accumX += dx;
        this._accumY += dy;
    }

    _onSwipeEnd(fingers, cancelled) {
        const mode = this._activeMode;
        const effectiveFingers = fingers >= 3 ? fingers : this._activeFingers;
        const totalX = this._accumX;
        const totalY = this._accumY;

        this._resetGestureState();

        if (mode === 'drag') {
            this._dragger?.endDrag(cancelled);
            return;
        }

        if (mode !== 'swipe' || cancelled || !this._settings)
            return;

        if (effectiveFingers !== 3 && effectiveFingers !== 4)
            return;

        const threshold = this._settings.get_int('swipe-threshold');
        if (Math.hypot(totalX, totalY) < threshold)
            return;

        let dir;
        if (Math.abs(totalX) >= Math.abs(totalY)) {
            const invertH = this._settings.get_boolean('invert-horizontal');
            const movingRight = totalX > 0;
            dir = (movingRight !== invertH) ? 'right' : 'left';
        } else {
            const invertV = this._settings.get_boolean('invert-vertical');
            const movingDown = totalY > 0;
            dir = (movingDown !== invertV) ? 'down' : 'up';
        }

        const keyPrefix = `swipe-${effectiveFingers}-${dir}`;
        const actionId = this._settings.get_string(keyPrefix);
        const customCmd = this._settings.get_string(`${keyPrefix}-cmd`);

        if (!actionId || actionId === 'none')
            return;

        console.log(
            `[TouchpadFlow] Swipe ${effectiveFingers}f ${dir} (dx=${totalX.toFixed(1)}, dy=${totalY.toFixed(1)}) -> ${actionId}`
        );

        // Defer briefly (20ms) so Xorg finishes releasing the passive swipe grab before
        // modal GNOME actions (Overview, App Grid, Screenshot UI) call Main.pushModal().
        this._cancelPendingAction();
        this._pendingActionTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            this._pendingActionTimeoutId = 0;
            this._actions?.run(actionId, customCmd);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onBackendStatus(status) {
        if (!status)
            return;

        if (status.t === 'ready') {
            const devList = Array.isArray(status.devices) ? status.devices.join(', ') : '';
            console.log(`[TouchpadFlow] Ready (${status.mode}): ${devList}`);
        } else if (status.t === 'warn') {
            console.warn(`[TouchpadFlow] ${status.code}: ${status.msg}`);
        } else if (status.t === 'error') {
            console.error(`[TouchpadFlow] ${status.code}: ${status.msg}`);
            if (!this._notifiedError && this._settings) {
                this._notifiedError = true;
                const lang = this._settings.get_string('ui-language');
                const t = getTranslations(lang);
                const msg = getLocalizedErrorMessage(lang, status.code, status.msg);
                try {
                    Main.notify(t.notif_title, msg);
                } catch {
                    // Ignore if notification tray isn't ready
                }
            }
        }
    }
}
