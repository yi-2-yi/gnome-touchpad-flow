#!/usr/bin/env bash
set -euo pipefail

UUID="touchpad-flow@local"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "==> 1. 准备 GSettings Schema..."
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas --strict "${SRC_DIR}/schemas"
else
    echo "    (使用已预编译的 schemas/gschemas.compiled，无需额外安装工具)"
fi

echo "==> 2. 安装扩展到当前用户目录 ${TARGET_DIR}（全程无需 sudo）..."
mkdir -p "${TARGET_DIR}"
cp -a "${SRC_DIR}/metadata.json" "${TARGET_DIR}/"
cp -a "${SRC_DIR}/extension.js" "${TARGET_DIR}/"
cp -a "${SRC_DIR}/prefs.js" "${TARGET_DIR}/"
rm -rf "${TARGET_DIR}/lib" "${TARGET_DIR}/helper" "${TARGET_DIR}/schemas"
cp -a "${SRC_DIR}/lib" "${TARGET_DIR}/"
cp -a "${SRC_DIR}/helper" "${TARGET_DIR}/"
cp -a "${SRC_DIR}/schemas" "${TARGET_DIR}/"
chmod +x "${TARGET_DIR}/helper/gesture-bridge.py"

echo "==> 3. 自检触控板手势后端..."
if CHECK_OUT="$(python3 "${TARGET_DIR}/helper/gesture-bridge.py" --check 2>&1)"; then
    echo "    ✓ 后端就绪：${CHECK_OUT}"
else
    echo "    ! 自检提示：${CHECK_OUT}"
    echo "    注：在 Debian 13 默认 X11 (Xorg 21.1 + libinput 驱动) 下，XInput 2.4 后端完全免 sudo。"
    echo "    如果当前未在图形桌面终端运行，请在桌面打开终端后重试自检。"
fi

echo "==> 4. 启用扩展..."
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "${UUID}" 2>/dev/null || true
fi

echo ""
echo "============================================================"
echo "安装完成！（全程无需 sudo 权限，也无需注销）"
echo ""
echo "下一步操作："
echo "1. 在 X11 下直接按 Alt + F2，输入 r 然后回车重载 GNOME Shell 即可生效。"
echo "2. 打开图形化设置界面自定义手势："
echo "       gnome-extensions prefs ${UUID}"
echo "============================================================"
