#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

# 手机作为 SoundBridge 主机的安装脚本（Termux）
# 用法：在 Termux 中执行
#   bash install.sh
#
# 安装完成后，手动执行：
#   ~/soundbridge/deploy/phone-host/start.sh

REPO_URL="${REPO_URL:-https://github.com/yuyuan0409/soundbridge.git}"
APP_DIR="$HOME/soundbridge"

echo "== 1/4 安装 Termux 依赖 =="
pkg update -y
pkg install -y nodejs-lts git wget tar

echo "== 2/4 获取项目 =="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev

echo "== 3/4 安装 ngrok =="
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) NGROK_ARCH="arm64" ;;
  armv7l|armv8l|arm) NGROK_ARCH="arm" ;;
  x86_64|amd64) NGROK_ARCH="amd64" ;;
  *)
    echo "不支持的 CPU 架构：$ARCH"
    exit 1
    ;;
esac

NGROK_TGZ="$HOME/ngrok.tgz"
wget -O "$NGROK_TGZ" "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${NGROK_ARCH}.tgz"
tar -xzf "$NGROK_TGZ" -C "$HOME"
chmod +x "$HOME/ngrok"

echo "== 4/4 配置 ngrok =="
echo "浏览器打开：https://dashboard.ngrok.com/get-started/your-authtoken"
echo "复制你的 Authtoken（只需要一次）。"
read -r -s -p "ngrok Authtoken: " TOKEN
echo
"$HOME/ngrok" config add-authtoken "$TOKEN"

echo "浏览器打开：https://dashboard.ngrok.com/domains"
echo "复制你的免费 dev domain，例如 abc123.ngrok-free.dev"
read -r -p "dev domain: " DOMAIN
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"

umask 077
printf 'NGROK_DOMAIN=%s\n' "$DOMAIN" > "$HOME/.soundbridge-phone.env"

echo
echo "安装完成。"
echo "启动命令："
echo "  ~/soundbridge/deploy/phone-host/start.sh"
