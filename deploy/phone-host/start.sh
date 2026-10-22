#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

APP_DIR="$HOME/soundbridge"
ENV_FILE="$HOME/.soundbridge-phone.env"
PORT="8787"

if [ ! -f "$ENV_FILE" ]; then
  echo "没有找到 $ENV_FILE"
  echo "请先运行 install.sh 完成配置。"
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

if [ -z "${NGROK_DOMAIN:-}" ]; then
  echo "NGROK_DOMAIN 为空，请重新运行 install.sh。"
  exit 1
fi
if [ ! -x "$HOME/ngrok" ]; then
  echo "没有找到 $HOME/ngrok，请重新运行 install.sh。"
  exit 1
fi
if [ ! -d "$APP_DIR" ]; then
  echo "没有找到项目目录 $APP_DIR"
  exit 1
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
fi

cd "$APP_DIR"
export HTTPS=0
export PORT="$PORT"
export HOST=127.0.0.1
export PUBLIC_URL="https://$NGROK_DOMAIN"

NODE_LOG="$HOME/soundbridge-server.log"
NGROK_LOG="$HOME/soundbridge-ngrok.log"
: > "$NODE_LOG"
: > "$NGROK_LOG"

NODE_PID=""
NGROK_PID=""
cleanup() {
  if [ -n "$NGROK_PID" ] && kill -0 "$NGROK_PID" 2>/dev/null; then
    kill "$NGROK_PID" 2>/dev/null || true
  fi
  if [ -n "$NODE_PID" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill "$NODE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "正在启动本地服务..."
node server/index.js > "$NODE_LOG" 2>&1 &
NODE_PID="$!"

HEALTH_OK=0
for _ in $(seq 1 30); do
  if wget -qO- "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 1
done

if [ "$HEALTH_OK" != "1" ]; then
  echo "本地服务没有启动成功，日志如下："
  tail -n 30 "$NODE_LOG" || true
  exit 1
fi

echo "正在启动 ngrok..."
"$HOME/ngrok" http "$PORT" \
  --url="https://$NGROK_DOMAIN" \
  --log=stdout \
  --log-format=logfmt > "$NGROK_LOG" 2>&1 &
NGROK_PID="$!"

sleep 4
if ! kill -0 "$NGROK_PID" 2>/dev/null; then
  echo "--url 方式未启动，尝试 --domain 方式..."
  "$HOME/ngrok" http "$PORT" \
    --domain="$NGROK_DOMAIN" \
    --log=stdout \
    --log-format=logfmt >> "$NGROK_LOG" 2>&1 &
  NGROK_PID="$!"
  sleep 4
fi

if ! kill -0 "$NGROK_PID" 2>/dev/null; then
  echo "ngrok 启动失败，日志如下："
  tail -n 50 "$NGROK_LOG" || true
  exit 1
fi

echo
echo "================================================"
echo "  声桥手机主机已启动"
echo "  网址：https://$NGROK_DOMAIN"
echo "  本地：http://127.0.0.1:$PORT"
echo "  日志：$NODE_LOG"
echo "        $NGROK_LOG"
echo "  按 Ctrl+C 停止"
echo "================================================"
echo

while kill -0 "$NODE_PID" 2>/dev/null; do
  if ! kill -0 "$NGROK_PID" 2>/dev/null; then
    echo "ngrok 已退出，最近日志："
    tail -n 30 "$NGROK_LOG" || true
    break
  fi
  sleep 5
done

echo "服务已停止。"
