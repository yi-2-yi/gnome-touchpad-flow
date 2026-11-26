# Touchpad Flow — GNOME 48 (Debian 13 X11 / Wayland) 触控板手势扩展

专为 **Debian 13 (Trixie) + GNOME 48 + X11** 打造的触控板增强扩展（同时也自动兼容 Wayland），**全程无需 `sudo` 权限**。

## 核心功能

1. **macOS 风格三指标题栏拖拽窗口**
   - 将光标移动到任意窗口的**标题栏**区域，直接用**三指轻触并移动**即可丝滑拖拽窗口，无需按下触控板。
   - 支持**光标跟随窗口移动**（松手后光标仍停留在标题栏）。
   - 支持**最大化窗口拖离**：对已最大化窗口的标题栏三指拖拽超过阈值时自动还原并锚定在光标下。
   - 支持**屏幕边缘松手自动贴边/最大化**（顶部最大化、左/右半屏平铺）。
   - 支持在设置中调节标题栏识别高度、拖拽灵敏度倍率，或开启“窗口任意位置拖拽”。

2. **高度可定制的三指 & 四指方向滑动手势**
   - 当光标不在标题栏（或在桌面/概览）时，三指上/下/左/右滑动分别触发自定义动作；四指四个方向也全部可定制。
   - 内置 25+ 种常用动作：智能活动概览/应用网格、切换工作区、移动窗口到相邻工作区、切换窗口、最大化/还原、最小化、关闭窗口、左/右半屏平铺、全屏、显示桌面、浏览器前进/后退、音量与媒体控制、GNOME 截图工具，以及**任意自定义 Shell 命令**。

## 为什么无需 `sudo` 权限就能在 X11 下运行？

在 GNOME 48 的 **X11 会话**中，Mutter 本身不会把底层多指触控板事件转发给 GNOME Shell。
本扩展内置的轻量桥接脚本 (`helper/gesture-bridge.py`) 采用三级自动适配后端：

1. **首选（免 sudo）：XInput 2.4 (`libX11.so.6` + `libXi.so.6`)**
   - Debian 13 自带的 Xorg 21.1 + `xserver-xorg-input-libinput` 原生支持 **XInput 2.4** 触控板手势协议。
   - 通过在根窗口注册 `XIGrabSwipeGestureBegin` 被动抓取，普通用户即可全局接收实时 3 指 / 4 指滑动增量 `(delta_x, delta_y)`，**无需 `sudo`、无需加入 `input` 组、无需安装任何额外软件包、无需注销重新登录**。
   - 仅捕获 3 指及以上滑动手势，完全不影响单指移动/点击、双指滚动、双指捏合缩放与键盘输入。
2. **自动回退：`libinput.so.10` / `libinput debug-events`**
   - 若系统使用旧版 Xorg 或已有其他程序占用了根窗口手势抓取（例如同时运行了 Touchegg），则自动回退到 `libinput` 后端（此回退模式需 `input` 组权限）。

## 免 sudo 一键安装步骤（Debian 13）

1. 在 Debian 13 终端克隆仓库并执行安装脚本（全部写入 `~/.local`，不涉及任何系统目录）：
   ```bash
   git clone https://github.com/yi-2-yi/gnome-touchpad-flow.git
   cd gnome-touchpad-flow
   chmod +x install.sh
   ./install.sh
   ```

2. 在 X11 桌面下按 `Alt + F2`，输入 `r` 后回车重载 GNOME Shell 即可立即生效。

3. 打开图形化设置窗口自定义手势：
   ```bash
   gnome-extensions prefs touchpad-flow@local
   ```

## 常见问题排查

- **检查当前生效的后端模式与识别到的触控板**：
  ```bash
  python3 ~/.local/share/gnome-shell/extensions/touchpad-flow@local/helper/gesture-bridge.py --check
  ```
  正常在 Debian 13 X11 桌面下应输出 `mode: "xinput-2.4 (免 sudo)"` 以及你的触控板设备名。
- **查看实时日志**：
  ```bash
  journalctl -f -o cat /usr/bin/gnome-shell | grep TouchpadFlow
  ```
- **如果安装了 Touchegg 等其他 X11 手势工具**：请先停止或卸载它们，避免抢占 X11 根窗口的 `XIGrabSwipeGestureBegin` 手势抓取。
