/**
 * Shared action definitions and constants.
 * Pure JS only (no Shell / Clutter / GTK imports) so both extension.js and prefs.js can import it.
 */

export const SWIPE_ACTIONS = [
    { id: 'none', label: '无操作（禁用）' },
    { id: 'open-overview-or-apps', label: '智能概览：桌面 → 活动概览 → 应用网格' },
    { id: 'close-overview-or-desktop', label: '智能返回：应用网格 → 活动概览 → 显示桌面' },
    { id: 'toggle-overview', label: '切换活动概览 (Overview)' },
    { id: 'toggle-app-grid', label: '切换应用程序网格 (App Grid)' },
    { id: 'workspace-next', label: '切换到下一个工作区（右）' },
    { id: 'workspace-prev', label: '切换到上一个工作区（左）' },
    { id: 'move-window-workspace-next', label: '将当前窗口移至下一个工作区' },
    { id: 'move-window-workspace-prev', label: '将当前窗口移至上一个工作区' },
    { id: 'switch-window-next', label: '切换到下一个窗口' },
    { id: 'switch-window-prev', label: '切换到上一个窗口' },
    { id: 'toggle-maximize', label: '最大化 / 还原当前窗口' },
    { id: 'minimize-window', label: '最小化当前窗口' },
    { id: 'close-window', label: '关闭当前窗口' },
    { id: 'tile-left', label: '左半屏平铺当前窗口' },
    { id: 'tile-right', label: '右半屏平铺当前窗口' },
    { id: 'toggle-fullscreen', label: '切换当前窗口全屏' },
    { id: 'show-desktop', label: '显示 / 恢复桌面' },
    { id: 'browser-back', label: '后退 (Alt + Left)' },
    { id: 'browser-forward', label: '前进 (Alt + Right)' },
    { id: 'volume-up', label: '增大音量' },
    { id: 'volume-down', label: '减小音量' },
    { id: 'volume-mute', label: '静音切换' },
    { id: 'media-play-pause', label: '媒体播放 / 暂停' },
    { id: 'screenshot-ui', label: '打开 GNOME 截图工具' },
    { id: 'custom-command', label: '自定义 Shell 命令...' },
];

export const ACTION_LABELS = Object.fromEntries(
    SWIPE_ACTIONS.map(a => [a.id, a.label])
);

export const DIRECTIONS = [
    { key: 'up', label: '向上滑动', icon: 'go-up-symbolic' },
    { key: 'down', label: '向下滑动', icon: 'go-down-symbolic' },
    { key: 'left', label: '向左滑动', icon: 'go-previous-symbolic' },
    { key: 'right', label: '向右滑动', icon: 'go-next-symbolic' },
];
