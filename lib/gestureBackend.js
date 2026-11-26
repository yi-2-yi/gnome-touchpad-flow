import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

/**
 * Unified touchpad swipe gesture backend.
 *
 * - On X11 (GNOME 48 Xorg): spawns `helper/gesture-bridge.py` to stream raw
 *   libinput swipe events (with 2D dx/dy deltas) over stdout JSON-Lines.
 * - On Wayland: hooks Clutter.EventType.TOUCHPAD_SWIPE directly on global.stage.
 */
export class GestureBackend {
    constructor(extensionDir, callbacks) {
        this._extensionDir = extensionDir;
        this._callbacks = callbacks;

        this._isWayland = Meta.is_wayland_compositor();
        this._destroyed = false;

        // X11 helper state
        this._proc = null;
        this._stdoutStream = null;
        this._cancellable = null;
        this._restartTimeoutId = 0;
        this._restartAttempts = 0;
        this._fatalError = false;

        // Wayland state
        this._stageEventId = 0;
        this._waylandConsuming = false;
    }

    get isWayland() {
        return this._isWayland;
    }

    start() {
        if (this._isWayland)
            this._startWayland();
        else
            this._startX11Bridge();
    }

    destroy() {
        this._destroyed = true;

        if (this._restartTimeoutId) {
            GLib.Source.remove(this._restartTimeoutId);
            this._restartTimeoutId = 0;
        }

        if (this._stageEventId) {
            global.stage.disconnect(this._stageEventId);
            this._stageEventId = 0;
        }

        this._stopX11Bridge();
    }

    // ==================== Wayland Native Backend ====================

    _startWayland() {
        this._callbacks.onStatus?.({
            t: 'ready',
            mode: 'wayland-native',
            devices: ['GNOME Wayland Touchpad'],
        });

        this._stageEventId = global.stage.connect('captured-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
                return Clutter.EVENT_PROPAGATE;

            const fingers = event.get_touchpad_gesture_finger_count();
            if (fingers < 3)
                return Clutter.EVENT_PROPAGATE;

            const phase = event.get_gesture_phase();
            if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
                this._waylandConsuming = Boolean(this._callbacks.onSwipeBegin?.(fingers));
                return this._waylandConsuming ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
            }

            if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
                if (!this._waylandConsuming)
                    return Clutter.EVENT_PROPAGATE;
                const [dx, dy] = event.get_gesture_motion_delta();
                this._callbacks.onSwipeUpdate?.(fingers, dx, dy);
                return Clutter.EVENT_STOP;
            }

            if (phase === Clutter.TouchpadGesturePhase.END ||
                phase === Clutter.TouchpadGesturePhase.CANCEL) {
                const wasConsuming = this._waylandConsuming;
                this._waylandConsuming = false;
                if (!wasConsuming)
                    return Clutter.EVENT_PROPAGATE;
                const cancelled = phase === Clutter.TouchpadGesturePhase.CANCEL;
                this._callbacks.onSwipeEnd?.(fingers, cancelled);
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });
    }

    // ==================== X11 libinput Bridge Backend ====================

    _startX11Bridge() {
        if (this._destroyed || this._fatalError)
            return;

        this._stopX11Bridge();

        const helperPath = this._extensionDir.get_child('helper').get_child('gesture-bridge.py').get_path();
        if (!GLib.file_test(helperPath, GLib.FileTest.EXISTS)) {
            this._fatalError = true;
            this._callbacks.onStatus?.({
                t: 'error',
                code: 'MISSING_HELPER',
                msg: `未找到手势桥接脚本：${helperPath}`,
            });
            return;
        }

        try {
            this._cancellable = new Gio.Cancellable();
            this._proc = new Gio.Subprocess({
                argv: ['python3', '-u', helperPath],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            this._proc.init(this._cancellable);

            const stdoutPipe = this._proc.get_stdout_pipe();
            this._stdoutStream = new Gio.DataInputStream({
                base_stream: stdoutPipe,
                close_base_stream: true,
            });

            this._readNextLine();

            this._proc.wait_async(this._cancellable, (proc, res) => {
                try {
                    proc.wait_finish(res);
                } catch {
                    // Cancelled during normal shutdown
                    return;
                }

                if (this._destroyed || this._fatalError)
                    return;

                this._scheduleRestart();
            });
        } catch (err) {
            console.error(`[TouchpadFlow] Failed to launch X11 bridge: ${err}`);
            this._callbacks.onStatus?.({
                t: 'error',
                code: 'SPAWN_FAILED',
                msg: `无法启动手势监听进程：${err.message}`,
            });
        }
    }

    _readNextLine() {
        if (!this._stdoutStream || !this._cancellable || this._cancellable.is_cancelled())
            return;

        this._stdoutStream.read_line_async(
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (stream, res) => {
                let line = null;
                try {
                    [line] = stream.read_line_finish_utf8(res);
                } catch (err) {
                    if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[TouchpadFlow] Stream read error: ${err.message}`);
                    return;
                }

                if (line === null)
                    return; // EOF

                if (line.length > 0)
                    this._handleBridgeMessage(line);

                if (!this._destroyed)
                    this._readNextLine();
            }
        );
    }

    _handleBridgeMessage(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }

        switch (msg.t) {
            case 'swipe_begin':
                this._callbacks.onSwipeBegin?.(msg.f);
                break;
            case 'swipe_update':
                this._callbacks.onSwipeUpdate?.(msg.f, msg.dx, msg.dy);
                break;
            case 'swipe_end':
                this._callbacks.onSwipeEnd?.(msg.f, Boolean(msg.c));
                break;
            case 'ready':
                this._restartAttempts = 0;
                this._callbacks.onStatus?.(msg);
                break;
            case 'warn':
                this._callbacks.onStatus?.(msg);
                break;
            case 'error':
                if (msg.code === 'NO_PERMISSION' || msg.code === 'NO_LIBINPUT' || msg.code === 'NO_BACKEND')
                    this._fatalError = true;
                this._callbacks.onStatus?.(msg);
                break;
        }
    }

    _scheduleRestart() {
        if (this._restartAttempts >= 3) {
            this._callbacks.onStatus?.({
                t: 'error',
                code: 'BRIDGE_CRASHED',
                msg: '触控板手势桥接进程多次意外退出，请检查 journalctl 日志。',
            });
            return;
        }

        this._restartAttempts += 1;
        const delayMs = this._restartAttempts * 1500;
        this._restartTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._restartTimeoutId = 0;
            this._startX11Bridge();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopX11Bridge() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._stdoutStream) {
            try {
                this._stdoutStream.close(null);
            } catch {
                // Ignore close errors
            }
            this._stdoutStream = null;
        }

        if (this._proc) {
            try {
                this._proc.force_exit();
            } catch {
                // Process already exited
            }
            this._proc = null;
        }
    }
}
