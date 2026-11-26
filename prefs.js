import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { DIRECTIONS, SWIPE_ACTIONS } from './lib/constants.js';

export default class TouchpadFlowPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(680, 660);

        this._buildDragPage(window, settings);
        this._buildSwipePage(window, settings, 3, '三指手势', 'input-touchpad-symbolic');
        this._buildSwipePage(window, settings, 4, '四指手势', 'preferences-desktop-gestures-symbolic');
    }

    // ==================== Page 1: Titlebar Drag & Status ====================

    _buildDragPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: '标题栏拖拽',
            icon_name: 'window-maximize-symbolic',
        });

        // Live environment status group
        const statusGroup = new Adw.PreferencesGroup({
            title: '运行状态（X11 XInput 2.4 / libinput 检测）',
            description: '在 Debian 13 GNOME 48 (X11) 下优先使用免 sudo 的 XInput 2.4 协议读取触控板手势，无需 root 或 input 组权限。',
        });
        const statusRow = new Adw.ActionRow({
            title: '正在检测触控板后端...',
            subtitle: '请稍候',
        });
        statusGroup.add(statusRow);
        page.add(statusGroup);

        this._runDiagnostics(window, statusRow);

        // Main drag settings group
        const dragGroup = new Adw.PreferencesGroup({
            title: 'macOS 风格三指拖拽窗口',
            description: '将光标停留在窗口标题栏上，三指按触并移动即可平滑拖拽窗口，无需按压触控板。',
        });

        const enableDragRow = new Adw.SwitchRow({
            title: '启用三指标题栏拖拽窗口',
            subtitle: '在窗口标题栏区域使用三指滑动直接移动窗口',
        });
        settings.bind('enable-titlebar-drag', enableDragRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dragGroup.add(enableDragRow);

        const titlebarHeightRow = new Adw.SpinRow({
            title: '标题栏识别高度（逻辑像素）',
            subtitle: '从窗口顶部向下识别为标题栏的区域高度（默认 48px，兼容 GTK/Qt/Chrome/VS Code）',
            adjustment: new Gtk.Adjustment({
                lower: 24,
                upper: 120,
                step_increment: 2,
                page_increment: 10,
            }),
        });
        settings.bind('titlebar-height', titlebarHeightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        dragGroup.add(titlebarHeightRow);

        const sensitivityRow = new Adw.SpinRow({
            title: '拖拽移动灵敏度倍率',
            subtitle: '数值越大，手指移动相同距离时窗口移动越快',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.4,
                upper: 5.0,
                step_increment: 0.1,
                page_increment: 0.5,
            }),
        });
        settings.bind('drag-sensitivity', sensitivityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        dragGroup.add(sensitivityRow);

        const followPointerRow = new Adw.SwitchRow({
            title: '拖拽时光标跟随窗口移动',
            subtitle: '与 macOS 一致：松手后光标保持在标题栏上',
        });
        settings.bind('drag-follow-pointer', followPointerRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dragGroup.add(followPointerRow);

        const edgeSnapRow = new Adw.SwitchRow({
            title: '边缘松手自动贴边 / 最大化',
            subtitle: '拖至屏幕顶部松手最大化，拖至左/右边缘松手半屏平铺',
        });
        settings.bind('drag-edge-snap', edgeSnapRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dragGroup.add(edgeSnapRow);

        const unmaxThresholdRow = new Adw.SpinRow({
            title: '最大化窗口拖离阈值（像素）',
            subtitle: '对最大化窗口标题栏三指拖拽超过此距离时自动还原并跟随移动',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 80,
                step_increment: 2,
                page_increment: 10,
            }),
        });
        settings.bind('drag-unmaximize-threshold', unmaxThresholdRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        dragGroup.add(unmaxThresholdRow);

        const dragAnywhereRow = new Adw.SwitchRow({
            title: '允许在窗口任意位置三指拖拽（高级）',
            subtitle: '开启后在窗口内容区三指滑动也会拖拽窗口，不再触发三指方向手势',
        });
        settings.bind('drag-anywhere', dragAnywhereRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dragGroup.add(dragAnywhereRow);

        page.add(dragGroup);
        window.add(page);
    }

    // ==================== Pages 2 & 3: 3-Finger & 4-Finger Swipes ====================

    _buildSwipePage(window, settings, fingers, title, iconName) {
        const page = new Adw.PreferencesPage({
            title,
            icon_name: iconName,
        });

        const generalGroup = new Adw.PreferencesGroup({
            title: `${fingers}指方向滑动总开关`,
            description: fingers === 3
                ? '当光标不在窗口标题栏（或处于桌面/概览）时，三指往不同方向滑动将触发以下动作。'
                : '四指往不同方向滑动将触发以下自定义动作（与三指标题栏拖拽互不冲突）。',
        });

        const enableKey = fingers === 3 ? 'enable-three-finger-swipe' : 'enable-four-finger-swipe';
        const enableRow = new Adw.SwitchRow({
            title: `启用${fingers}指方向滑动手势`,
        });
        settings.bind(enableKey, enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(enableRow);

        if (fingers === 3) {
            const thresholdRow = new Adw.SpinRow({
                title: '滑动触发距离阈值',
                subtitle: '数值越小越灵敏，数值越大越防误触（默认 55）',
                adjustment: new Gtk.Adjustment({
                    lower: 15,
                    upper: 200,
                    step_increment: 5,
                    page_increment: 20,
                }),
            });
            settings.bind('swipe-threshold', thresholdRow, 'value', Gio.SettingsBindFlags.DEFAULT);
            generalGroup.add(thresholdRow);

            const invertHRow = new Adw.SwitchRow({
                title: '反转水平滑动方向',
                subtitle: '切换左右滑动的方向映射（自然方向 / 传统方向）',
            });
            settings.bind('invert-horizontal', invertHRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            generalGroup.add(invertHRow);

            const invertVRow = new Adw.SwitchRow({
                title: '反转垂直滑动方向',
                subtitle: '切换上下滑动的方向映射',
            });
            settings.bind('invert-vertical', invertVRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            generalGroup.add(invertVRow);

            const osdRow = new Adw.SwitchRow({
                title: '触发手势时显示屏幕提示 (OSD)',
                subtitle: '每次触发滑动动作时在屏幕下方短暂显示动作名称',
            });
            settings.bind('show-osd-feedback', osdRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            generalGroup.add(osdRow);
        }

        page.add(generalGroup);

        // Direction mappings group
        const dirGroup = new Adw.PreferencesGroup({
            title: `${fingers}指各方向动作映射`,
            description: '为上、下、左、右四个方向分别选择动作；选择“自定义 Shell 命令”后可填写任意终端命令。',
        });

        const actionIds = SWIPE_ACTIONS.map(a => a.id);
        const actionLabels = SWIPE_ACTIONS.map(a => a.label);

        for (const dir of DIRECTIONS) {
            const key = `swipe-${fingers}-${dir.key}`;
            const cmdKey = `${key}-cmd`;

            const comboRow = new Adw.ComboRow({
                title: `${fingers}指${dir.label}`,
                model: Gtk.StringList.new(actionLabels),
            });

            const currentAction = settings.get_string(key);
            const initialIdx = Math.max(0, actionIds.indexOf(currentAction));
            comboRow.set_selected(initialIdx);

            const cmdRow = new Adw.EntryRow({
                title: `${fingers}指${dir.label} · 自定义命令`,
                show_apply_button: true,
                visible: currentAction === 'custom-command',
            });
            cmdRow.set_text(settings.get_string(cmdKey));
            cmdRow.connect('apply', () => {
                settings.set_string(cmdKey, cmdRow.get_text());
            });
            cmdRow.connect('changed', () => {
                settings.set_string(cmdKey, cmdRow.get_text());
            });

            comboRow.connect('notify::selected', () => {
                const idx = comboRow.get_selected();
                const selectedId = actionIds[idx] ?? 'none';
                settings.set_string(key, selectedId);
                cmdRow.set_visible(selectedId === 'custom-command');
            });

            dirGroup.add(comboRow);
            dirGroup.add(cmdRow);
        }

        page.add(dirGroup);
        window.add(page);
    }

    // ==================== Diagnostics Helper ====================

    _runDiagnostics(window, statusRow) {
        const sessionType = GLib.getenv('XDG_SESSION_TYPE') || 'unknown';
        if (sessionType === 'wayland') {
            statusRow.set_title('Wayland 原生手势模式已就绪');
            statusRow.set_subtitle('当前会话为 Wayland，将直接通过 GNOME Clutter 接收触控板手势。');
            return;
        }

        const helperPath = this.dir.get_child('helper').get_child('gesture-bridge.py').get_path();
        const cancellable = new Gio.Cancellable();
        window.connect('close-request', () => {
            cancellable.cancel();
            return false;
        });

        try {
            const proc = new Gio.Subprocess({
                argv: ['python3', helperPath, '--check'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(cancellable);
            proc.communicate_utf8_async(null, cancellable, (p, res) => {
                if (cancellable.is_cancelled())
                    return;

                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    const firstLine = (stdout || '').trim().split('\n')[0];
                    const info = firstLine ? JSON.parse(firstLine) : null;

                    if (info?.t === 'ready') {
                        const devs = (info.devices || []).join('、');
                        statusRow.set_title(`X11 后端运行正常（${info.mode}）`);
                        statusRow.set_subtitle(`已识别触控板：${devs || '已就绪'}`);
                    } else if (info?.msg) {
                        statusRow.set_title(`需要配置（${info.code || 'ERROR'}）`);
                        statusRow.set_subtitle(info.msg);
                    } else {
                        statusRow.set_title('无法确认触控板状态');
                        statusRow.set_subtitle('请确认当前用户已加入 input 组并重新登录。');
                    }
                } catch (err) {
                    if (!cancellable.is_cancelled()) {
                        statusRow.set_title('检测失败');
                        statusRow.set_subtitle(err.message);
                    }
                }
            });
        } catch (err) {
            statusRow.set_title('无法执行检测脚本');
            statusRow.set_subtitle(err.message);
        }
    }
}
