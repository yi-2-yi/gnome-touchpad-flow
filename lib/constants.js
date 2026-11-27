/**
 * Shared action IDs and direction keys.
 * Pure JS only (no Shell / Clutter / GTK imports) so both extension.js and prefs.js can import it.
 */

export const SWIPE_ACTION_IDS = [
    'none',
    'open-overview-or-apps',
    'close-overview-or-desktop',
    'toggle-overview',
    'toggle-app-grid',
    'workspace-next',
    'workspace-prev',
    'move-window-workspace-next',
    'move-window-workspace-prev',
    'switch-window-next',
    'switch-window-prev',
    'toggle-maximize',
    'minimize-window',
    'close-window',
    'tile-left',
    'tile-right',
    'toggle-fullscreen',
    'show-desktop',
    'browser-back',
    'browser-forward',
    'volume-up',
    'volume-down',
    'volume-mute',
    'media-play-pause',
    'screenshot-ui',
    'custom-command',
];

export const DIRECTIONS = [
    { key: 'up', labelKey: 'dir_up', icon: 'go-up-symbolic' },
    { key: 'down', labelKey: 'dir_down', icon: 'go-down-symbolic' },
    { key: 'left', labelKey: 'dir_left', icon: 'go-previous-symbolic' },
    { key: 'right', labelKey: 'dir_right', icon: 'go-next-symbolic' },
];
