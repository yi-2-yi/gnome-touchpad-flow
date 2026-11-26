import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ActionRunner } from './lib/actionRunner.js';
import { GestureBackend } from './lib/gestureBackend.js';
import { WindowDragger } from './lib/windowDragger.js';

export default class TouchpadFlowExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._dragger = new WindowDragger(this._settings);
        this._actions = new ActionRunner(this._settings);

        this._accumX = 0;
        this._accumY = 0;
        this._swipeTriggered = false;
        this._activeMode = 'none'; // 'none' | 'drag' | 'swipe'
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
        this._swipeTriggered = false;
        this._activeMode = 'none';
    }

    _onSwipeBegin(fingers) {
        this._resetGestureState();

        if (!this._settings || Main.sessionMode.isLocked)
            return false;

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

    _onSwipeUpdate(fingers, dx, dy) {
        if (!this._settings)
            return;

        if (this._activeMode === 'drag') {
            this._dragger.updateDrag(dx, dy);
            return;
        }

        if (this._activeMode !== 'swipe' || this._swipeTriggered)
            return;

        if (fingers !== 3 && fingers !== 4)
            return;

        this._accumX += dx;
        this._accumY += dy;

        const threshold = this._settings.get_int('swipe-threshold');
        if (Math.hypot(this._accumX, this._accumY) < threshold)
            return;

        this._swipeTriggered = true;

        let dir;
        if (Math.abs(this._accumX) >= Math.abs(this._accumY)) {
            const invertH = this._settings.get_boolean('invert-horizontal');
            const movingRight = this._accumX > 0;
            dir = (movingRight !== invertH) ? 'right' : 'left';
        } else {
            const invertV = this._settings.get_boolean('invert-vertical');
            const movingDown = this._accumY > 0;
            dir = (movingDown !== invertV) ? 'down' : 'up';
        }

        const keyPrefix = `swipe-${fingers}-${dir}`;
        const actionId = this._settings.get_string(keyPrefix);
        const customCmd = this._settings.get_string(`${keyPrefix}-cmd`);

        this._actions.run(actionId, customCmd);
    }

    _onSwipeEnd(_fingers, cancelled) {
        if (this._activeMode === 'drag')
            this._dragger?.endDrag(cancelled);

        this._resetGestureState();
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
            if (!this._notifiedError) {
                this._notifiedError = true;
                try {
                    Main.notify('Touchpad Flow 触控板手势', status.msg);
                } catch {
                    // Ignore if notification tray isn't ready
                }
            }
        }
    }
}
