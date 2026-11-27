#!/usr/bin/env python3
"""
Touchpad Flow - X11 touchpad gesture bridge for GNOME Shell 48.

Backend priority (automatic):
1. XInput 2.4 (libX11.so.6 + libXi.so.6) via XIGrabSwipeGestureBegin on the root
   window. Requires NO sudo, NO `input` group membership, NO relogin, and NO
   extra apt packages on Debian 13 (Xorg 21.1+).
2. libinput C library (libinput.so.10 + libudev.so.1) via ctypes (used as
   fallback if XInput 2.4 is unavailable or another client holds a swipe grab;
   requires `input` group membership).
3. `libinput debug-events` CLI fallback (if libinput-tools is installed).

Privacy & performance:
- Only 3+ finger swipe gestures are captured; keyboards, normal 1-finger pointer
  motion, 2-finger scroll, and pinch gestures are untouched.
- Uses blocking select() on the X11 / libinput fd (0% CPU when idle).
- Uses Linux PR_SET_PDEATHSIG so it exits immediately if GNOME Shell terminates.
"""

import ctypes
import ctypes.util
import errno
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys

# ==================== XInput 2.4 ABI Constants ====================

GENERIC_EVENT = 35

XI_ALL_DEVICES = 0
XI_ALL_MASTER_DEVICES = 1
XI_MASTER_POINTER = 1
XI_GESTURE_CLASS = 9

XI_GRAB_MODE_ASYNC = 1
XI_ANY_MODIFIER = 1 << 31

XI_GESTURE_SWIPE_BEGIN = 30
XI_GESTURE_SWIPE_UPDATE = 31
XI_GESTURE_SWIPE_END = 32
XI_GESTURE_SWIPE_EVENT_CANCELLED = 1 << 0

# ==================== libinput ABI Constants ====================

LIBINPUT_DEVICE_CAP_GESTURE = 5
LIBINPUT_CONFIG_SEND_EVENTS_DISABLED = 1

LIBINPUT_EVENT_DEVICE_ADDED = 1
LIBINPUT_EVENT_DEVICE_REMOVED = 2
LIBINPUT_EVENT_GESTURE_SWIPE_BEGIN = 800
LIBINPUT_EVENT_GESTURE_SWIPE_UPDATE = 801
LIBINPUT_EVENT_GESTURE_SWIPE_END = 802

PR_SET_PDEATHSIG = 1

_running = True


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        sys.exit(0)


def setup_parent_death_signal():
    """Ensure this helper exits automatically if the parent (gnome-shell) dies."""
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM)
    except Exception:
        pass


def handle_signal(_signum, _frame):
    global _running
    _running = False


def load_shared_lib(candidates):
    for name in candidates:
        if not name:
            continue
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    return None


# ==================== Backend 1: XInput 2.4 (Zero-Sudo) ====================

class XIModifierState(ctypes.Structure):
    _fields_ = [
        ("base", ctypes.c_int),
        ("latched", ctypes.c_int),
        ("locked", ctypes.c_int),
        ("effective", ctypes.c_int),
    ]


class XIEventMask(ctypes.Structure):
    _fields_ = [
        ("deviceid", ctypes.c_int),
        ("mask_len", ctypes.c_int),
        ("mask", ctypes.POINTER(ctypes.c_ubyte)),
    ]


class XIGrabModifiers(ctypes.Structure):
    _fields_ = [
        ("modifiers", ctypes.c_uint),
        ("status", ctypes.c_int),
    ]


class XIAnyClassInfo(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("sourceid", ctypes.c_int),
    ]


class XIDeviceInfo(ctypes.Structure):
    _fields_ = [
        ("deviceid", ctypes.c_int),
        ("name", ctypes.c_char_p),
        ("use", ctypes.c_int),
        ("attachment", ctypes.c_int),
        ("enabled", ctypes.c_int),
        ("num_classes", ctypes.c_int),
        ("classes", ctypes.POINTER(ctypes.POINTER(XIAnyClassInfo))),
    ]


class XGenericEventCookie(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("extension", ctypes.c_int),
        ("evtype", ctypes.c_int),
        ("cookie", ctypes.c_uint),
        ("data", ctypes.c_void_p),
    ]


class XEvent(ctypes.Union):
    _fields_ = [
        ("type", ctypes.c_int),
        ("xcookie", XGenericEventCookie),
        ("pad", ctypes.c_long * 24),
    ]


class XIGestureSwipeEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("extension", ctypes.c_int),
        ("evtype", ctypes.c_int),
        ("time", ctypes.c_ulong),
        ("deviceid", ctypes.c_int),
        ("sourceid", ctypes.c_int),
        ("detail", ctypes.c_int),
        ("root", ctypes.c_ulong),
        ("event", ctypes.c_ulong),
        ("child", ctypes.c_ulong),
        ("root_x", ctypes.c_double),
        ("root_y", ctypes.c_double),
        ("event_x", ctypes.c_double),
        ("event_y", ctypes.c_double),
        ("delta_x", ctypes.c_double),
        ("delta_y", ctypes.c_double),
        ("delta_unaccel_x", ctypes.c_double),
        ("delta_unaccel_y", ctypes.c_double),
        ("flags", ctypes.c_int),
        ("mods", XIModifierState),
        ("group", XIModifierState),
    ]


class XErrorEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("resourceid", ctypes.c_ulong),
        ("serial", ctypes.c_ulong),
        ("error_code", ctypes.c_ubyte),
        ("request_code", ctypes.c_ubyte),
        ("minor_code", ctypes.c_ubyte),
    ]


def _xi_set_mask(buf, evtype):
    buf[evtype >> 3] |= 1 << (evtype & 7)


def run_xinput24(check_only=False):
    """
    Try zero-sudo XInput 2.4 passive root-window swipe grab.
    Returns True if handled (success or check_only completed), False to fall back.
    """
    if not os.environ.get("DISPLAY"):
        return False

    libx11 = load_shared_lib(["libX11.so.6", ctypes.util.find_library("X11"), "libX11.so"])
    libxi = load_shared_lib(["libXi.so.6", ctypes.util.find_library("Xi"), "libXi.so"])
    if not libx11 or not libxi:
        return False

    # Require XInput 2.4 symbol in libXi
    if not hasattr(libxi, "XIGrabSwipeGestureBegin"):
        return False

    # Configure X11 / libXi signatures
    XERROR_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(XErrorEvent))

    libx11.XOpenDisplay.restype = ctypes.c_void_p
    libx11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    libx11.XCloseDisplay.restype = ctypes.c_int
    libx11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    libx11.XDefaultScreen.restype = ctypes.c_int
    libx11.XDefaultScreen.argtypes = [ctypes.c_void_p]
    libx11.XRootWindow.restype = ctypes.c_ulong
    libx11.XRootWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libx11.XConnectionNumber.restype = ctypes.c_int
    libx11.XConnectionNumber.argtypes = [ctypes.c_void_p]
    libx11.XQueryExtension.restype = ctypes.c_int
    libx11.XQueryExtension.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_int),
    ]
    libx11.XSetErrorHandler.restype = ctypes.c_void_p
    libx11.XSetErrorHandler.argtypes = [XERROR_HANDLER]
    libx11.XSync.restype = ctypes.c_int
    libx11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libx11.XFlush.restype = ctypes.c_int
    libx11.XFlush.argtypes = [ctypes.c_void_p]
    libx11.XPending.restype = ctypes.c_int
    libx11.XPending.argtypes = [ctypes.c_void_p]
    libx11.XNextEvent.restype = ctypes.c_int
    libx11.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.POINTER(XEvent)]
    libx11.XGetEventData.restype = ctypes.c_int
    libx11.XGetEventData.argtypes = [ctypes.c_void_p, ctypes.POINTER(XGenericEventCookie)]
    libx11.XFreeEventData.restype = None
    libx11.XFreeEventData.argtypes = [ctypes.c_void_p, ctypes.POINTER(XGenericEventCookie)]

    libxi.XIQueryVersion.restype = ctypes.c_int
    libxi.XIQueryVersion.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_int),
    ]
    libxi.XIQueryDevice.restype = ctypes.POINTER(XIDeviceInfo)
    libxi.XIQueryDevice.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
    libxi.XIFreeDeviceInfo.restype = None
    libxi.XIFreeDeviceInfo.argtypes = [ctypes.POINTER(XIDeviceInfo)]
    libxi.XIGrabSwipeGestureBegin.restype = ctypes.c_int
    libxi.XIGrabSwipeGestureBegin.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.POINTER(XIEventMask),
        ctypes.c_int,
        ctypes.POINTER(XIGrabModifiers),
    ]
    libxi.XIUngrabSwipeGestureBegin.restype = ctypes.c_int
    libxi.XIUngrabSwipeGestureBegin.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_int,
        ctypes.POINTER(XIGrabModifiers),
    ]

    dpy = libx11.XOpenDisplay(None)
    if not dpy:
        return False

    x_errors = []

    def on_x_error(_dpy, err_ptr):
        if err_ptr:
            x_errors.append(int(err_ptr.contents.error_code))
        return 0

    err_cb = XERROR_HANDLER(on_x_error)
    libx11.XSetErrorHandler(err_cb)

    try:
        xi_opcode = ctypes.c_int(0)
        first_event = ctypes.c_int(0)
        first_error = ctypes.c_int(0)
        if not libx11.XQueryExtension(
            dpy,
            b"XInputExtension",
            ctypes.byref(xi_opcode),
            ctypes.byref(first_event),
            ctypes.byref(first_error),
        ):
            return False

        major = ctypes.c_int(2)
        minor = ctypes.c_int(4)
        status = libxi.XIQueryVersion(dpy, ctypes.byref(major), ctypes.byref(minor))
        if status != 0 or (major.value < 2 or (major.value == 2 and minor.value < 4)):
            return False

        # Discover gesture-capable touchpads and their master pointers
        ndevices = ctypes.c_int(0)
        devs = libxi.XIQueryDevice(dpy, XI_ALL_DEVICES, ctypes.byref(ndevices))
        if not devs:
            return False

        gesture_device_names = []
        master_pointer_ids = []
        gesture_master_ids = set()

        try:
            for i in range(ndevices.value):
                info = devs[i]
                if not info.enabled:
                    continue
                if info.use == XI_MASTER_POINTER:
                    master_pointer_ids.append(info.deviceid)

                has_gesture = False
                for c in range(info.num_classes):
                    cls_ptr = info.classes[c]
                    if cls_ptr and cls_ptr.contents.type == XI_GESTURE_CLASS:
                        has_gesture = True
                        break

                if has_gesture:
                    name = info.name.decode("utf-8", errors="replace") if info.name else f"Device {info.deviceid}"
                    if info.use == XI_MASTER_POINTER:
                        gesture_master_ids.add(info.deviceid)
                    else:
                        gesture_device_names.append(name)
                        if info.attachment > 0:
                            gesture_master_ids.add(info.attachment)
        finally:
            libxi.XIFreeDeviceInfo(devs)

        target_masters = sorted(gesture_master_ids) if gesture_master_ids else master_pointer_ids[:1]
        if not target_masters:
            return False

        # In --check mode, avoid grabbing so we never collide with a live running bridge
        if check_only:
            if not gesture_device_names and not gesture_master_ids:
                return False
            devices_report = gesture_device_names or [f"XInput 2.4 (device {d})" for d in target_masters]
            emit({
                "t": "ready",
                "mode": "xinput-2.4",
                "devices": devices_report,
            })
            sys.exit(0)

        screen = libx11.XDefaultScreen(dpy)
        root = libx11.XRootWindow(dpy, screen)

        mask_buf = (ctypes.c_ubyte * 8)()
        _xi_set_mask(mask_buf, XI_GESTURE_SWIPE_BEGIN)
        _xi_set_mask(mask_buf, XI_GESTURE_SWIPE_UPDATE)
        _xi_set_mask(mask_buf, XI_GESTURE_SWIPE_END)

        grabbed_devices = []
        for dev_id in target_masters:
            ev_mask = XIEventMask(dev_id, 8, mask_buf)
            mods = XIGrabModifiers(XI_ANY_MODIFIER, 0)
            x_errors.clear()
            failed = libxi.XIGrabSwipeGestureBegin(
                dpy,
                dev_id,
                root,
                XI_GRAB_MODE_ASYNC,
                XI_GRAB_MODE_ASYNC,
                0,  # owner_events = False
                ctypes.byref(ev_mask),
                1,
                ctypes.byref(mods),
            )
            libx11.XSync(dpy, 0)
            if failed == 0 and not x_errors:
                grabbed_devices.append(dev_id)

        if not grabbed_devices:
            return False

        devices_report = gesture_device_names or [f"XInput 2.4 (device {d})" for d in grabbed_devices]
        emit({
            "t": "ready",
            "mode": "xinput-2.4",
            "devices": devices_report,
        })

        xfd = libx11.XConnectionNumber(dpy)
        xev = XEvent()
        active_fingers = 0

        try:
            while _running:
                while libx11.XPending(dpy) > 0:
                    libx11.XNextEvent(dpy, ctypes.byref(xev))
                    if xev.type != GENERIC_EVENT:
                        continue
                    cookie = xev.xcookie
                    if cookie.extension != xi_opcode.value:
                        continue
                    if not libx11.XGetEventData(dpy, ctypes.byref(xev.xcookie)):
                        continue
                    try:
                        evtype = xev.xcookie.evtype
                        if evtype in (
                            XI_GESTURE_SWIPE_BEGIN,
                            XI_GESTURE_SWIPE_UPDATE,
                            XI_GESTURE_SWIPE_END,
                        ) and xev.xcookie.data:
                            gev = ctypes.cast(
                                xev.xcookie.data, ctypes.POINTER(XIGestureSwipeEvent)
                            ).contents
                            detail_fingers = int(gev.detail)
                            if evtype == XI_GESTURE_SWIPE_BEGIN:
                                active_fingers = detail_fingers
                                if active_fingers >= 3:
                                    emit({"t": "swipe_begin", "f": active_fingers})
                            elif evtype == XI_GESTURE_SWIPE_UPDATE:
                                fingers = detail_fingers if detail_fingers >= 3 else active_fingers
                                if fingers >= 3:
                                    emit({
                                        "t": "swipe_update",
                                        "f": fingers,
                                        "dx": round(float(gev.delta_x), 3),
                                        "dy": round(float(gev.delta_y), 3),
                                    })
                            elif evtype == XI_GESTURE_SWIPE_END:
                                fingers = detail_fingers if detail_fingers >= 3 else active_fingers
                                active_fingers = 0
                                if fingers >= 3:
                                    cancelled = bool(gev.flags & XI_GESTURE_SWIPE_EVENT_CANCELLED)
                                    libx11.XFlush(dpy)
                                    emit({"t": "swipe_end", "f": fingers, "c": cancelled})
                    finally:
                        libx11.XFreeEventData(dpy, ctypes.byref(xev.xcookie))

                if not _running:
                    break
                try:
                    select.select([xfd], [], [], 1.0)
                except InterruptedError:
                    continue
        finally:
            for dev_id in grabbed_devices:
                mods = XIGrabModifiers(XI_ANY_MODIFIER, 0)
                libxi.XIUngrabSwipeGestureBegin(dpy, dev_id, root, 1, ctypes.byref(mods))
            libx11.XFlush(dpy)

        return True
    finally:
        libx11.XCloseDisplay(dpy)


# ==================== Backend 2: libinput ctypes (Fallback) ====================

def run_ctypes_libinput(check_only=False):
    libinput = load_shared_lib([
        "libinput.so.10",
        ctypes.util.find_library("input"),
        "libinput.so",
    ])
    libudev = load_shared_lib([
        "libudev.so.1",
        ctypes.util.find_library("udev"),
        "libudev.so",
    ])
    if not libinput or not libudev:
        return False

    OPEN_CB = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p)
    CLOSE_CB = ctypes.CFUNCTYPE(None, ctypes.c_int, ctypes.c_void_p)

    class LibinputInterface(ctypes.Structure):
        _fields_ = [
            ("open_restricted", OPEN_CB),
            ("close_restricted", CLOSE_CB),
        ]

    libudev.udev_new.restype = ctypes.c_void_p
    libudev.udev_new.argtypes = []
    libudev.udev_unref.restype = ctypes.c_void_p
    libudev.udev_unref.argtypes = [ctypes.c_void_p]

    libinput.libinput_udev_create_context.restype = ctypes.c_void_p
    libinput.libinput_udev_create_context.argtypes = [
        ctypes.POINTER(LibinputInterface),
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    libinput.libinput_udev_assign_seat.restype = ctypes.c_int
    libinput.libinput_udev_assign_seat.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    libinput.libinput_get_fd.restype = ctypes.c_int
    libinput.libinput_get_fd.argtypes = [ctypes.c_void_p]
    libinput.libinput_dispatch.restype = ctypes.c_int
    libinput.libinput_dispatch.argtypes = [ctypes.c_void_p]
    libinput.libinput_get_event.restype = ctypes.c_void_p
    libinput.libinput_get_event.argtypes = [ctypes.c_void_p]
    libinput.libinput_event_get_type.restype = ctypes.c_int
    libinput.libinput_event_get_type.argtypes = [ctypes.c_void_p]
    libinput.libinput_event_get_device.restype = ctypes.c_void_p
    libinput.libinput_event_get_device.argtypes = [ctypes.c_void_p]
    libinput.libinput_event_get_gesture_event.restype = ctypes.c_void_p
    libinput.libinput_event_get_gesture_event.argtypes = [ctypes.c_void_p]
    libinput.libinput_event_destroy.restype = None
    libinput.libinput_event_destroy.argtypes = [ctypes.c_void_p]
    libinput.libinput_device_has_capability.restype = ctypes.c_int
    libinput.libinput_device_has_capability.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libinput.libinput_device_get_name.restype = ctypes.c_char_p
    libinput.libinput_device_get_name.argtypes = [ctypes.c_void_p]
    libinput.libinput_device_config_send_events_set_mode.restype = ctypes.c_int
    libinput.libinput_device_config_send_events_set_mode.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
    ]
    libinput.libinput_event_gesture_get_finger_count.restype = ctypes.c_int
    libinput.libinput_event_gesture_get_finger_count.argtypes = [ctypes.c_void_p]
    libinput.libinput_event_gesture_get_dx.restype = ctypes.c_double
    libinput.libinput_event_gesture_get_dx.argtypes = [ctypes.c_void_p]
    libinput.libinput_event_gesture_get_dy.restype = ctypes.c_double
    libinput.libinput_event_gesture_get_dy.argtypes = [ctypes.c_void_p]
    libinput.libinput_event_gesture_get_cancelled.restype = ctypes.c_int
    libinput.libinput_event_gesture_get_cancelled.argtypes = [ctypes.c_void_p]
    libinput.libinput_unref.restype = ctypes.c_void_p
    libinput.libinput_unref.argtypes = [ctypes.c_void_p]

    permission_errors = 0
    opened_count = 0

    def open_restricted(path, _flags, _user_data):
        nonlocal permission_errors, opened_count
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            opened_count += 1
            return fd
        except OSError as exc:
            err = exc.errno or errno.EACCES
            if err in (errno.EACCES, errno.EPERM):
                permission_errors += 1
            return -err

    def close_restricted(fd, _user_data):
        try:
            os.close(fd)
        except OSError:
            pass

    open_cb = OPEN_CB(open_restricted)
    close_cb = CLOSE_CB(close_restricted)
    iface = LibinputInterface(open_cb, close_cb)

    udev = libudev.udev_new()
    if not udev:
        emit({"t": "error", "code": "UDEV_ERROR", "msg": "Failed to initialize libudev"})
        return True

    li = libinput.libinput_udev_create_context(ctypes.byref(iface), None, udev)
    if not li:
        libudev.udev_unref(udev)
        emit({"t": "error", "code": "LIBINPUT_ERROR", "msg": "Failed to create libinput context"})
        return True

    seat = os.environ.get("XDG_SEAT", "seat0").encode("utf-8")
    if libinput.libinput_udev_assign_seat(li, seat) != 0:
        libinput.libinput_unref(li)
        libudev.udev_unref(udev)
        emit({"t": "error", "code": "SEAT_ERROR", "msg": f"Failed to assign seat {seat.decode()}"})
        return True

    gesture_devices = {}

    def process_events():
        libinput.libinput_dispatch(li)
        while True:
            ev = libinput.libinput_get_event(li)
            if not ev:
                break
            try:
                ev_type = libinput.libinput_event_get_type(ev)
                if ev_type == LIBINPUT_EVENT_DEVICE_ADDED:
                    dev = libinput.libinput_event_get_device(ev)
                    if dev:
                        has_gesture = libinput.libinput_device_has_capability(
                            dev, LIBINPUT_DEVICE_CAP_GESTURE
                        )
                        if has_gesture:
                            raw_name = libinput.libinput_device_get_name(dev)
                            name = raw_name.decode("utf-8", errors="replace") if raw_name else "Touchpad"
                            gesture_devices[dev] = name
                        else:
                            libinput.libinput_device_config_send_events_set_mode(
                                dev, LIBINPUT_CONFIG_SEND_EVENTS_DISABLED
                            )
                elif ev_type == LIBINPUT_EVENT_DEVICE_REMOVED:
                    dev = libinput.libinput_event_get_device(ev)
                    gesture_devices.pop(dev, None)
                elif ev_type == LIBINPUT_EVENT_GESTURE_SWIPE_BEGIN:
                    gev = libinput.libinput_event_get_gesture_event(ev)
                    fingers = libinput.libinput_event_gesture_get_finger_count(gev)
                    if fingers >= 3:
                        emit({"t": "swipe_begin", "f": fingers})
                elif ev_type == LIBINPUT_EVENT_GESTURE_SWIPE_UPDATE:
                    gev = libinput.libinput_event_get_gesture_event(ev)
                    fingers = libinput.libinput_event_gesture_get_finger_count(gev)
                    if fingers >= 3:
                        dx = libinput.libinput_event_gesture_get_dx(gev)
                        dy = libinput.libinput_event_gesture_get_dy(gev)
                        emit({
                            "t": "swipe_update",
                            "f": fingers,
                            "dx": round(dx, 3),
                            "dy": round(dy, 3),
                        })
                elif ev_type == LIBINPUT_EVENT_GESTURE_SWIPE_END:
                    gev = libinput.libinput_event_get_gesture_event(ev)
                    fingers = libinput.libinput_event_gesture_get_finger_count(gev)
                    if fingers >= 3:
                        cancelled = bool(libinput.libinput_event_gesture_get_cancelled(gev))
                        emit({"t": "swipe_end", "f": fingers, "c": cancelled})
            finally:
                libinput.libinput_event_destroy(ev)

    process_events()

    if opened_count == 0 and permission_errors > 0:
        emit({
            "t": "error",
            "code": "NO_PERMISSION",
            "msg": "XInput 2.4 不可用且无权限读取 /dev/input/event*。请确认 Xorg 使用 libinput 驱动（免 sudo），或将用户加入 input 组。",
        })
        libinput.libinput_unref(li)
        libudev.udev_unref(udev)
        if check_only:
            sys.exit(2)
        return True

    if not gesture_devices:
        emit({
            "t": "warn" if not check_only else "error",
            "code": "NO_TOUCHPAD",
            "msg": "未检测到支持多指手势的触控板设备（如连接蓝牙触控板后将自动识别）",
        })
        if check_only:
            libinput.libinput_unref(li)
            libudev.udev_unref(udev)
            sys.exit(3)
    else:
        emit({
            "t": "ready",
            "mode": "libinput-ctypes",
            "devices": list(gesture_devices.values()),
        })
        if check_only:
            libinput.libinput_unref(li)
            libudev.udev_unref(udev)
            sys.exit(0)

    fd = libinput.libinput_get_fd(li)
    try:
        while _running:
            try:
                rlist, _, _ = select.select([fd], [], [], 1.0)
            except InterruptedError:
                continue
            if rlist:
                process_events()
    finally:
        libinput.libinput_unref(li)
        libudev.udev_unref(udev)

    return True


# ==================== Backend 3: libinput CLI (Last Fallback) ====================

def run_cli_fallback(check_only=False):
    libinput_bin = shutil.which("libinput")
    if not libinput_bin:
        emit({
            "t": "error",
            "code": "NO_BACKEND",
            "msg": "XInput 2.4 与 libinput 后端均不可用（请确保在 X11 会话中运行，且触控板由 xserver-xorg-input-libinput 驱动）",
        })
        sys.exit(1)

    if check_only:
        res = subprocess.run(
            [libinput_bin, "list-devices"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if res.returncode != 0 or "Permission denied" in res.stderr:
            emit({
                "t": "error",
                "code": "NO_PERMISSION",
                "msg": "XInput 2.4 不可用且无权限读取 /dev/input/event*。",
            })
            sys.exit(2)
        emit({"t": "ready", "mode": "libinput-cli", "devices": ["libinput-cli"]})
        sys.exit(0)

    stdbuf = shutil.which("stdbuf")
    cmd = ([stdbuf, "-oL"] if stdbuf else []) + [libinput_bin, "debug-events"]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    re_begin = re.compile(r"GESTURE_SWIPE_BEGIN\s+\S+\s+(\d+)")
    re_update = re.compile(r"GESTURE_SWIPE_UPDATE\s+\S+\s+(\d+)\s+([-\d.]+)/([-\d.]+)")
    re_end = re.compile(r"GESTURE_SWIPE_END\s+\S+\s+(\d+)(?:\s+(cancelled))?")

    emit({"t": "ready", "mode": "libinput-cli", "devices": ["libinput-cli"]})

    try:
        for line in proc.stdout:
            if not _running:
                break
            if "GESTURE_SWIPE_" not in line:
                continue
            m = re_update.search(line)
            if m:
                fingers = int(m.group(1))
                if fingers >= 3:
                    emit({
                        "t": "swipe_update",
                        "f": fingers,
                        "dx": float(m.group(2)),
                        "dy": float(m.group(3)),
                    })
                continue
            m = re_begin.search(line)
            if m:
                fingers = int(m.group(1))
                if fingers >= 3:
                    emit({"t": "swipe_begin", "f": fingers})
                continue
            m = re_end.search(line)
            if m:
                fingers = int(m.group(1))
                if fingers >= 3:
                    emit({
                        "t": "swipe_end",
                        "f": fingers,
                        "c": bool(m.group(2)),
                    })
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    setup_parent_death_signal()
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    check_only = "--check" in sys.argv
    force_libinput = "--libinput" in sys.argv

    if not force_libinput and run_xinput24(check_only=check_only):
        return
    if not run_ctypes_libinput(check_only=check_only):
        run_cli_fallback(check_only=check_only)


if __name__ == "__main__":
    main()
