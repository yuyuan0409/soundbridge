# 用 Android 手机当服务器（Termux，非官方）

> **结论：技术上可以，但不推荐把它当成长期稳定方案。**
> Cloudflare 没有官方的 Android 版 `cloudflared`，也没有“装个插件就开机自启”的 APK。下面是用 Termux 手动运行 Node 服务 + Cloudflare Tunnel 的方式，属于非官方用法。

## 适用场景

- 你只有一部 Android 手机，没有电脑；
- 愿意让手机长期插电、保持 Wi-Fi / 移动网络；
- 接受 Android 可能杀后台、重启后自启不一定成功；
- 只需要两个人临时或小规模使用。

如果要求“手机没电、关机、重启后也一定可用”，请使用云端部署，见 [README.md](README.md) 的 Render / VPS 方案。

---

## 先理解三个事实

1. **Cloudflare Tunnel 只是连接器**，它把公网请求转发到你手机上的 Node 服务；它自己不运行声桥。
2. **Cloudflare 没有官方 Android 版 cloudflared**。Termux 里运行的是 Linux ARM 二进制，不保证所有手机都兼容。
3. **Quick Tunnel 的地址每次重启都会变**。要固定地址必须用 Named Tunnel + 自己的域名。

---

## 需要安装

从 **F-Droid** 安装（不要用来路不明的“Termux 插件版”）：

- Termux
- Termux:Boot（开机自启需要）

安装后先各打开一次。Termux:Boot 需要允许自启动。

---

## 1. 安装运行环境

在 Termux 中：

```bash
pkg update
pkg install nodejs-lts git curl unzip
node -v
```

Node 需要 20 或更高版本。

---

## 2. 放入项目

如果项目已经在 Git 仓库：

```bash
cd ~
git clone <你的仓库地址> soundbridge
cd soundbridge
npm ci --omit=dev
```

如果没有 Git 仓库，可以把项目压缩包放到手机下载目录，再用：

```bash
termux-setup-storage
cp ~/storage/downloads/soundbridge.zip ~/
unzip ~/soundbridge.zip -d ~/
cd ~/soundbridge
npm ci --omit=dev
```

---

## 3. 先在本机测试

```bash
cd ~/soundbridge
HTTPS=0 PORT=8787 HOST=127.0.0.1 node server/index.js
```

另开一个 Termux 会话：

```bash
curl http://127.0.0.1:8787/healthz
```

返回 `{"ok":true,...}` 后，按 `Ctrl+C` 停止。

---

## 4. 安装 cloudflared

先看 CPU 架构：

```bash
uname -m
```

常见结果：

- `aarch64` / `arm64` → 下载 `cloudflared-linux-arm64`
- `armv7l` / `arm` → 下载 `cloudflared-linux-arm`
- `x86_64` → 下载 `cloudflared-linux-amd64`

以 arm64 为例：

```bash
cd ~
curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
chmod +x cloudflared
./cloudflared --version
```

如果提示无法执行，说明手机/Android 版本不兼容这个二进制，这条路基本走不通，改用云端部署。

---

## 5A. 快速隧道（地址会变，只适合测试）

```bash
./cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
```

日志里会出现 `https://xxxx.trycloudflare.com`。手机重启或进程退出后会换新地址，不是永久地址。

---

## 5B. Named Tunnel（固定网址，需要域名）

前提：域名已经接入 Cloudflare。

```bash
./cloudflared tunnel login
./cloudflared tunnel create soundbridge
./cloudflared tunnel route dns soundbridge sound.example.com
```

创建 `~/.cloudflared/config.yml`：

```yaml
tunnel: <tunnel-uuid>
credentials-file: /data/data/com.termux/files/home/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: sound.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

运行：

```bash
./cloudflared tunnel run soundbridge
```

`cloudflared tunnel login` 需要浏览器授权；Termux 可以用 `termux-open-url` 打开它给出的链接。

---

## 6. 开机自启

创建 `~/.termux/boot/` 目录：

```bash
mkdir -p ~/.termux/boot
```

新建 `~/.termux/boot/soundbridge.sh`：

```bash
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd "$HOME/soundbridge" || exit 1
export HTTPS=0
export PORT=8787
export HOST=127.0.0.1
export PUBLIC_URL="https://sound.example.com"
nohup node server/index.js >> "$HOME/soundbridge.log" 2>&1 &
sleep 5
nohup "$HOME/cloudflared" tunnel run soundbridge >> "$HOME/cloudflared.log" 2>&1 &
```

赋予执行权限：

```bash
chmod +x ~/.termux/boot/soundbridge.sh
```

也把 `deploy/termux-boot.sh.example` 作为模板。

---

## 7. Android 设置

- 设置 → 应用 → Termux → 电池 → **不限制 / 允许后台活动**；
- 允许 Termux 使用后台数据和 Wi-Fi；
- 保持手机插电；
- 关闭“省电模式”对 Termux 的限制；
- 尽量不要在同一部手机上同时运行共享 APK 和 Termux 服务，后台竞争会更明显；
- 重启后打开 Termux 看一下 `soundbridge.log` 和 `cloudflared.log`。

---

## 8. 验证

在另一台设备或流量网络打开：

```text
https://sound.example.com/healthz
```

返回 JSON 即正常。然后打开网页创建房间，用 Android 共享端填同一个服务器地址。

---

## 重要限制

- 这是**非官方**方案，Android 版本、厂商省电策略、Termux 更新都可能影响；
- 手机必须一直有电、有网络，屏幕可以关但系统不能把 Termux 杀掉；
- Quick Tunnel 地址会变，不是永久网址；
- Named Tunnel 要求域名，仍然依赖手机在线；
- 手机重启后的自启不保证 100% 成功；
- 不要在同一部手机上同时长期运行 Termux 服务和共享 App，CPU / 电池 / 麦克风会互相竞争。

## 更推荐的做法

- **只想用手机管理，但不想让手机当服务器**：用手机浏览器部署到 Render，手机可以关机；
- **要真正 7×24 稳定**：VPS + 域名 + Caddy，或 Oracle Cloud Always Free；
- **完全不想维护设备**：把信令/中继改成 Cloudflare Workers + Durable Objects，这需要单独移植，当前 Node 服务不能直接当 Worker 运行。
