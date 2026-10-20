# 永久 / 长期网址部署

## 先说结论

**只把网址换掉，不能做到“电脑关机后还能用”。**

现在的地址是 Cloudflare 快速隧道，它只是把请求转发到这台电脑上的 Node 服务：

`浏览器 → Cloudflare 临时隧道 → 这台电脑的 8787 端口`

电脑关机、休眠、断网或隧道进程退出，地址就会失效。要长期在线，必须把 **Node 服务本身** 放到一台 7×24 运行的云主机 / 托管平台上。

下面几种方案的网址都可以长期不变，区别在于是否需要一直付费，以及空闲时会不会休眠。

---

## 方案对比

| 方案 | 网址 | 电脑关机可用 | 7×24 不休眠 | 费用 | 适合 |
| --- | --- | --- | --- | --- | --- |
| Render Free | `https://xxx.onrender.com` | 可以 | 否，空闲约 15 分钟后休眠 | 免费 | 先长期试用、偶尔用 |
| Render Starter | `https://xxx.onrender.com` 或自己的域名 | 可以 | 是 | 约 $7/月起 | 最省事的小型长期使用 |
| Fly.io | `https://xxx.fly.dev` 或自己的域名 | 可以 | 是（配置 `min_machines_running = 1`） | 按用量 | 愿意用命令行 |
| VPS + 域名 + Caddy | `https://sound.example.com` | 可以 | 是 | 服务器 $3–5/月 + 域名 | 推荐，完全可控 |
| Oracle Cloud Always Free | 公网 IP / 自己的域名 | 可以 | 是 | 免费额度 | 愿意自己维护 Linux |
| Cloudflare Workers | `*.workers.dev` 或自己的域名 | 可以 | 是（边缘运行） | 免费额度 / Workers Paid | 不想维护设备 |
| Cloudflare Named Tunnel | 自己的域名 | **否** | 取决于电脑 | 免费 | 只是想要固定网址，但电脑一直开着 |

> 如果目标是“电脑关了也能用”，不要把 Cloudflare Named Tunnel 当成最终方案；它仍然需要一台一直开着的机器。

---

## 没有域名怎么办

没有域名时，**不要再选 Cloudflare Workers 的 workers.dev 地址**：它在中国大陆经常被 DNS 污染/阻断，绑定自定义域名才是稳定方案。

可行选择：

### 1. Render（不需要域名）

Render 会分配平台子域名：

§§§text
https://soundbridge-xxxx.onrender.com
§§§

- 不需要购买域名；
- 不需要电脑或手机常开；
- 免费计划空闲会休眠，Starter 约 $7/月可保持在线；
- 需要 GitHub 仓库和 Render 账号；
- 手机没有电脑时，可以先下载 [Render 源码包](../public/downloads/soundbridge-render.zip)，用 Termux 解压后推到 GitHub。

### 2. VPS + DuckDNS（免费子域名）

DuckDNS 提供免费的 §xxx.duckdns.org§ 子域名，不需要购买域名：

1. 在 DuckDNS 创建一个子域名，把 IP 指向 VPS；
2. VPS 上运行 Docker + Caddy；
3. Caddy 使用 §xxx.duckdns.org§ 自动申请 Let's Encrypt 证书；
4. 在 §.env§ 设置：

§§§dotenv
PUBLIC_URL=https://xxx.duckdns.org
HTTPS=0
§§§

这个方案需要 VPS 费用，但在国内通常比 §workers.dev§ 稳定。

### 3. Oracle Cloud Always Free + DuckDNS

Oracle 的 Always Free 实例可以免费长期运行，再配 DuckDNS 子域名即可，不需要购买域名；但注册和 Linux 维护成本较高。

### 4. Cloudflare Workers + 免费域名

如果以后拿到一个可以接入 Cloudflare 的免费域名，再把 Worker 绑定自定义域名；§workers.dev§ 本身不适合国内长期使用。

## 方案 A：Render（最省事）

仓库里已经放了 `render.yaml`。

1. 把整个 `soundbridge` 目录推到 GitHub。
2. 打开 Render Dashboard → **New** → **Blueprint**。
3. 选择这个仓库，Render 会读取根目录的 `render.yaml`。
4. 部署完成后得到类似 `https://soundbridge-xxxx.onrender.com` 的长期地址。
5. 在 Render 的 Environment 里把 `PUBLIC_URL` 改成这个地址（或自己的域名），然后重新部署。
6. 用浏览器打开 `/healthz`，返回 JSON 即正常。

### 免费计划的重要限制

Render Free 在空闲约 15 分钟后会休眠：

- 第一次打开会冷启动，可能要等十几秒；
- 休眠会关闭 WebSocket，正在共享的房间会断开；
- 不适合“随时打开就能用”的场景。

要真正 7×24，改成 **Starter** 计划，或使用下面的 VPS / Fly 方案。

### 自定义域名

Render 支持绑定自己的域名，按 Dashboard 的 DNS 提示配置 CNAME / A 记录即可，HTTPS 证书由 Render 自动签发。

---

## 方案 B：Fly.io

仓库里已经放了 `fly.toml`。

```bash
# 安装 flyctl 后
fly auth login
fly launch --no-deploy --copy-config
# 修改 fly.toml 里的 app = "全局唯一名字"
fly deploy
```

配置里已经设置：

- `HTTPS=0`：TLS 由 Fly 的边缘代理终止，容器内只跑 HTTP；
- `min_machines_running = 1`：保持一台机器常驻，不会因为空闲关机；
- `auto_stop_machines = false`：禁止自动休眠。

注意：常驻机器会产生费用。 `fly.toml` 里的 `app` 必须先改成全局唯一名称。

---

## 方案 C：VPS + 域名 + Caddy（推荐长期）

这是最可控的方式，服务器关机才会断。

### 1. DNS

把自己的域名（例如 `sound.example.com`）的 A 记录指向 VPS 公网 IP。

### 2. 启动服务

在 VPS 上安装 Docker，然后：

```bash
git clone <你的仓库地址> soundbridge
cd soundbridge

cat > .env <<'EOF'
PUBLIC_URL=https://sound.example.com
HTTPS=0
PORT=8787
HOST=0.0.0.0
EOF

docker compose up -d --build
```

`compose.yaml` 已经设置了 `restart: unless-stopped`，服务器重启后容器会自动拉起。

### 3. Caddy 反向代理 + 自动 HTTPS

安装 Caddy，把 `deploy/Caddyfile` 里的域名改成自己的：

```text
sound.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787 {
        header_up X-Forwarded-For {remote_host}
    }
    header {
        -Server
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }
}
```

然后：

```bash
sudo systemctl reload caddy
```

Caddy 会自动申请和续期 Let's Encrypt 证书，并自动转发 WebSocket。

### 4. 防火墙

只开放：

- `80/tcp`：证书申请和 HTTP 跳转；
- `443/tcp`：HTTPS；
- SSH 端口。

不要直接把 `8787` 暴露到公网。

### 5. 验证

```bash
curl https://sound.example.com/healthz
```

返回 `{"ok":true,...}` 即正常。

---

## 方案 D：Oracle Cloud Always Free

Oracle Cloud 的 Always Free 实例可以长期免费运行，但需要自己装系统、Docker、Caddy，步骤与上面的 VPS 方案相同。注意免费实例也有 CPU / 内存额度，Opus 中继的带宽够两个人使用，但不要拿它跑大流量。

---

## 方案 E：手机当服务器（Termux，非官方，不推荐）

Cloudflare 没有官方 Android 版 cloudflared，也不能把 Node 服务做成一个“Cloudflare 插件”装进手机。

如果只有一部 Android 手机，可以在 Termux 里同时运行 Node 和 cloudflared，再用 Termux:Boot 做开机自启。但它不是官方方案，Android 可能杀后台，重启后自启也不保证成功；Quick Tunnel 地址每次重启还会变化。

完整步骤和限制见 **[android-termux.md](android-termux.md)**，开机脚本模板见 **termux-boot.sh.example**。

> 如果目标是“手机可以关机、电脑也可以关机，网址仍然长期可用”，不要用这个方案；请选 Render / Fly / VPS。

## 方案 F：Cloudflare Workers（不需要任何设备常开）

这是最彻底的方案：Worker 运行在 Cloudflare 边缘，Durable Object 负责房间、信令和 Opus 中继，部署后手机和电脑都可以关机。

- 地址：`https://soundbridge.<账号子域>.workers.dev`；**国内网络访问 workers.dev 经常被阻断，建议绑定自己的域名**
- 不需要 cloudflared、不需要 VPS、不需要端口转发
- 首次部署需要 Cloudflare 账号；Durable Objects 的免费额度/套餐以控制台为准

完整步骤见 **[cloudflare-workers.md](cloudflare-workers.md)**。临时预览可以用 `npx wrangler deploy --temporary`，但必须在 60 分钟内 claim，否则账号和地址会失效。

## 部署后还要做两件事

### 1. 设置 PUBLIC_URL

在托管平台的环境变量或 VPS 的 `.env` 中设置：

```dotenv
PUBLIC_URL=https://你的长期域名
HTTPS=0
```

重启服务。网页的“复制邀请链接”会优先使用这个地址。

如果不设置 `PUBLIC_URL`，网页会使用当前浏览器地址，通常也可以；但设置后更稳定，尤其是自定义域名。

### 2. 更新 Android 默认服务器地址

App 里可以直接手动修改服务器地址，不改 APK 也能用。

如果想让新安装的 APK 默认就连长期地址，修改：

`mobile/app/src/main/res/values/strings.xml`

```xml
<string name="default_server">https://sound.example.com</string>
```

然后重新构建 APK：

```powershell
cd mobile
.\gradlew assembleDebug
```

新的 APK 放到 `public/downloads/soundbridge-mobile.apk`，再部署一次站点。

---

## 需要注意

- 房间状态保存在服务器内存里，服务器重启 / 平台休眠后，正在进行的房间会失效，需要重新创建。
- 服务器只转发 Opus 音频包，不解码、不保存音频到磁盘。
- 中继带宽约为每方向 96 kbps，两个人使用时流量很小，但长期运行仍需考虑平台流量额度。
- 反向代理必须支持 WebSocket 升级；Caddy 和 Render/Fly 默认支持。
- 免费托管平台的休眠策略会直接影响实时音频；要稳定共享，选择不休眠的方案。
