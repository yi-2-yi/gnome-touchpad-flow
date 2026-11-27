import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { DIRECTIONS, SWIPE_ACTION_IDS } from './lib/constants.js';
import { getLocalizedErrorMessage, getTranslations, LANGUAGES } from './lib/i18n.js';

export default class TouchpadFlowPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(680, 680);

        const state = {
            pages: [],
            diagCancellable: null,
        };

        window.connect('close-request', () => {
            if (state.diagCancellable) {
                state.diagCancellable.cancel();
                state.diagCancellable = null;
            }
            return false;
        });

        const rebuildPages = (preservePageIndex = 0) => {
            if (state.diagCancellable) {
                state.diagCancellable.cancel();
                state.diagCancellable = null;
            }

            for (const oldPage of state.pages)
                window.remove(oldPage);
            state.pages = [];

            const lang = settings.get_string('ui-language') || 'en';
            const t = getTranslations(lang);

            const dragPage = this._buildDragPage(window, settings, lang, t, state, () => {
                rebuildPages(0);
            });
            const swipe3Page = this._buildSwipePage(settings, t, 3, t.page_swipe3, 'input-touchpad-symbolic');
            const swipe4Page = this._buildSwipePage(settings, t, 4, t.page_swipe4, 'preferences-desktop-gestures-symbolic');

            state.pages = [dragPage, swipe3Page, swipe4Page];
            for (const p of state.pages)
                window.add(p);

            const targetPage = state.pages[preservePageIndex] ?? state.pages[0];
            if (targetPage && typeof window.set_visible_page === 'function')
                window.set_visible_page(targetPage);
        };

        rebuildPages(0);
    }

    // ==================== Page 1: Language, Status & Titlebar Drag ====================

    _buildDragPage(_window, settings, lang, t, state, onLanguageChanged) {
        const page = new Adw.PreferencesPage({
            title: t.page_drag,
            icon_name: 'window-maximize-symbolic',
        });

        // Language & Live status group
        const generalGroup = new Adw.PreferencesGroup({
            title: t.group_general,
            description: t.group_general_desc,
        });

        const langIds = LANGUAGES.map(item => item.id);
        const langLabels = LANGUAGES.map(item => item.label);
        const langRow = new Adw.ComboRow({
            title: t.row_language,
            subtitle: t.row_language_sub,
            model: Gtk.StringList.new(langLabels),
        });
        langRow.set_selected(Math.max(0, langIds.indexOf(lang)));
        langRow.connect('notify::selected', () => {
            const newLang = langIds[langRow.get_selected()] ?? 'en';
            if (newLang !== settings.get_string('ui-language')) {
                settings.set_string('ui-language', newLang);
                onLanguageChanged();
            }
        });
        generalGroup.add(langRow);

        const statusRow = new Adw.ActionRow({
            title: t.status_checking_title,
            subtitle: t.status_checking_sub,
        });
        generalGroup.add(statusRow);
        page.add(generalGroup);

        this._runDiagnostics(statusRow, lang, t, state);

        // Main drag settings group
        const dragGroup = new Adw.PreferencesGroup({
            title: t.group_drag,
            description: t.group_drag_desc,
        });

        const enableDragRow = new Adw.SwitchRow({
            title: t.row_enable_drag,
            subtitle: t.row_enable_drag_sub,
        });
        settings.bind('enable-titlebar-drag', enableDragRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dragGroup.add(enableDragRow);

        const titlebarHeightRow = new Adw.SpinRow({
            title: t.row_titlebar_height,
            subtitle: t.row_titlebar_height_sub,
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
            title: t.row_drag_sensitivity,
            subtitle: t.row_drag_sensitivity_sub,
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
            title: t.row_follow_pointer,
            subtitle: t.row_follow_pointer_sub,
        });
        settings.bind('drag-follow-pointer', followPointerRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dragGroup.add(followPointerRow);

        const edgeSnapRow = new Adw.SwitchRow({
            title: t.row_edge_snap,
            subtitle: t.row_edge_snap_sub,
        });
        settings.bind('drag-edge-snap', edgeSnapRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dragGroup.add(edgeSnapRow);

        const unmaxThresholdRow = new Adw.SpinRow({
            title: t.row_unmax_threshold,
            subtitle: t.row_unmax_threshold_sub,
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
            title: t.row_drag_anywhere,
            subtitle: t.row_drag_anywhere_sub,
        });
        settings.bind('drag-anywhere', dragAnywhereRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dragGroup.add(dragAnywhereRow);

        page.add(dragGroup);
        return page;
    }

    // ==================== Pages 2 & 3: 3-Finger & 4-Finger Swipes ====================

    _buildSwipePage(settings, t, fingers, title, iconName) {
        const page = new Adw.PreferencesPage({
            title,
            icon_name: iconName,
        });

        const generalGroup = new Adw.PreferencesGroup({
            title: t.group_swipe_general(fingers),
            description: fingers === 3 ? t.group_swipe3_desc : t.group_swipe4_desc,
        });

        const enableKey = fingers === 3 ? 'enable-three-finger-swipe' : 'enable-four-finger-swipe';
        const enableRow = new Adw.SwitchRow({
            title: t.row_enable_swipe(fingers),
        });
        settings.bind(enableKey, enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(enableRow);

        if (fingers === 3) {
            const thresholdRow = new Adw.SpinRow({
                title: t.row_swipe_threshold,
                subtitle: t.row_swipe_threshold_sub,
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
                title: t.row_invert_h,
                subtitle: t.row_invert_h_sub,
            });
            settings.bind('invert-horizontal', invertHRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            generalGroup.add(invertHRow);

            const invertVRow = new Adw.SwitchRow({
                title: t.row_invert_v,
                subtitle: t.row_invert_v_sub,
            });
            settings.bind('invert-vertical', invertVRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            generalGroup.add(invertVRow);

            const osdRow = new Adw.SwitchRow({
                title: t.row_osd,
                subtitle: t.row_osd_sub,
            });
            settings.bind('show-osd-feedback', osdRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            generalGroup.add(osdRow);
        }

        page.add(generalGroup);

        // Direction mappings group
        const dirGroup = new Adw.PreferencesGroup({
            title: t.group_swipe_dirs(fingers),
            description: t.group_swipe_dirs_desc,
        });

        const actionLabels = SWIPE_ACTION_IDS.map(id => t.actions[id] ?? id);

        for (const dir of DIRECTIONS) {
            const key = `swipe-${fingers}-${dir.key}`;
            const cmdKey = `${key}-cmd`;
            const dirLabel = t[dir.labelKey];

            const comboRow = new Adw.ComboRow({
                title: t.row_dir_title(fingers, dirLabel),
                model: Gtk.StringList.new(actionLabels),
            });

            const currentAction = settings.get_string(key);
            const initialIdx = Math.max(0, SWIPE_ACTION_IDS.indexOf(currentAction));
            comboRow.set_selected(initialIdx);

            const cmdRow = new Adw.EntryRow({
                title: t.row_cmd_title(fingers, dirLabel),
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
                const selectedId = SWIPE_ACTION_IDS[idx] ?? 'none';
                settings.set_string(key, selectedId);
                cmdRow.set_visible(selectedId === 'custom-command');
            });

            dirGroup.add(comboRow);
            dirGroup.add(cmdRow);
        }

        page.add(dirGroup);
        return page;
    }

    // ==================== Diagnostics Helper ====================

    _runDiagnostics(statusRow, lang, t, state) {
        const sessionType = GLib.getenv('XDG_SESSION_TYPE') || 'unknown';
        if (sessionType === 'wayland') {
            statusRow.set_title(t.status_wayland_title);
            statusRow.set_subtitle(t.status_wayland_sub);
            return;
        }

        const helperPath = this.dir.get_child('helper').get_child('gesture-bridge.py').get_path();
        const cancellable = new Gio.Cancellable();
        state.diagCancellable = cancellable;

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
                        const devs = (info.devices || []).join(', ') || t.status_ready_fallback_dev;
                        statusRow.set_title(t.status_ready_title(info.mode));
                        statusRow.set_subtitle(t.status_ready_sub(devs));
                    } else if (info?.code || info?.msg) {
                        statusRow.set_title(t.status_error_title(info.code || 'ERROR'));
                        statusRow.set_subtitle(getLocalizedErrorMessage(lang, info.code, info.msg));
                    } else {
                        statusRow.set_title(t.status_unknown_title);
                        statusRow.set_subtitle(t.status_unknown_sub);
                    }
                } catch (err) {
                    if (!cancellable.is_cancelled()) {
                        statusRow.set_title(t.status_failed_title);
                        statusRow.set_subtitle(err.message);
                    }
                }
            });
        } catch (err) {
            statusRow.set_title(t.status_spawn_failed_title);
            statusRow.set_subtitle(err.message);
        }
    }
}
