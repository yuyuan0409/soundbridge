# Cloudflare Workers 部署（不需要手机或电脑常开）

这是方案三：把信令、房间状态和 Opus 中继迁移到 **Cloudflare Workers + Durable Objects**。

部署完成后：

- 地址是 Cloudflare 的 `*.workers.dev` 长期地址；
- 不需要电脑、不需要手机、不需要 cloudflared；
- 也不需要端口转发；
- 手机只是部署时的操作工具，部署完可以关机。

## 架构

```text
浏览器 / Android 共享端
        │  HTTPS + WSS
        ▼
Cloudflare Worker（静态资源 + /api/config）
        │  /ws
        ▼
RoomHub Durable Object（房间、信令、二进制中继）
```

房间数据在 Durable Object 内存中，不落盘；Worker 重启或重新部署后，正在进行的房间会失效。

## 先确认套餐

Cloudflare Workers 免费计划通常包含 SQLite-backed Durable Objects，但有额度限制；不同账号的可用策略以 Cloudflare 控制台为准。

如果部署时提示需要启用 Durable Objects，可以开通 Workers Paid；当前大约 `$5/月`。即使付费，也比长期 VPS 便宜，而且不需要维护机器。

## 只有手机也能部署

### 1. 安装 Termux

从 **F-Droid** 安装 Termux（不要用不明来源的“插件版”）。

```bash
pkg update
pkg install nodejs-lts git
node -v
```

### 2. 准备代码

如果项目在 Git 仓库：

```bash
cd ~
git clone <你的仓库地址> soundbridge
cd soundbridge
npm ci
```

也可以把压缩包复制到手机，再用 `termux-setup-storage` 和 `unzip` 解压。

### 3. 登录 Cloudflare

```bash
npx wrangler login
```

它会给出一个授权链接。Termux 可以用：

```bash
termux-open-url <授权链接>
```

在浏览器里登录并授权。

### 4. 部署

```bash
npx wrangler deploy
```

首次部署会创建：

- `soundbridge` Worker
- `RoomHub` Durable Object
- `public/` 静态资源
- `/ws` WebSocket 路由

成功后终端会输出类似：

```text
https://soundbridge.<你的账号子域>.workers.dev
```

> **重要：`workers.dev` 在中国大陆经常被 DNS 污染或阻断，可能解析到错误 IP、连接超时。即使部署和 claim 都成功，手机也可能打不开这个域名。**
>
> 要让国内网络稳定访问，必须绑定自己的自定义域名，或者改用香港/新加坡 VPS。

### 5. 验证

```bash
curl https://soundbridge.<你的账号子域>.workers.dev/healthz
```

应返回：

```json
{"ok":true,"rooms":0,"uptime":0,"secure":true,"edge":true}
```

再打开网页创建房间即可。

### 6. 填写到 Android

打开共享端 App，把服务器地址改成：

```text
https://soundbridge.<你的账号子域>.workers.dev
```

如果希望新安装的 APK 默认就是这个地址，修改：

`mobile/app/src/main/res/values/strings.xml`

```xml
<string name="default_server">https://soundbridge.你的账号子域.workers.dev</string>
```

然后重新构建 APK。

## 自定义域名（可选）

Cloudflare Dashboard → Workers & Pages → 选择 `soundbridge` → Settings → Domains & Routes → Add custom domain。

绑定后把这个域名填到 App 的服务器地址即可。Worker 的 `CF_PUBLIC_URL` 留空时会使用请求的 origin，一般不需要额外配置。

## 临时预览与 claim

如果暂时没有 Cloudflare 账号，可以先部署一个临时预览：

```bash
npx wrangler deploy --temporary
```

Wrangler 会创建一个临时账号并输出：

- 一个 `*.workers.dev` 预览地址；
- 一个 `claim-preview` 链接。

必须在 **60 分钟内**用这个链接把临时账号 claim 到自己的 Cloudflare 账号，否则 Worker 和地址会失效。临时预览只适合测试，不要把它当成永久地址。

正式长期使用仍然建议登录自己的账号后执行 `npx wrangler deploy`。

## 本地测试

在电脑或 Termux 上：

```bash
npm run worker:dev
```

另开终端：

```bash
node test/worker-protocol.mjs
```

完整浏览器测试：

```bash
E2E_BASE_URL=http://127.0.0.1:8788 npm run test:e2e
```

Windows PowerShell：

```powershell
$env:E2E_BASE_URL='http://127.0.0.1:8788'
npm run test:e2e
```

## 和 Node 版本的区别

- 房间状态放在一个全局 `RoomHub` Durable Object 中，适合两人房间的小规模使用；
- 所有房间共用一个 DO，不是按房间分片；
- 房间和连接不持久化，重新部署或 DO 重启会断开；
- WebRTC P2P 仍然优先；P2P 失败时走 Worker 的 WSS + Opus 中继；
- 静态文件由 Workers Assets 提供，APK 下载路径不变；
- 不需要 TURN；
- `workers.dev` 在国内的访问速度取决于网络，必要时绑定自己的域名。

## 打不开怎么办

### 临时预览地址失效

`deploy --temporary` 创建的临时账号只有 **60 分钟** claim 窗口。超过时间后 Worker 和地址都会被删除，这不是 claim 链接本身出错，而是临时方案已过期。

### workers.dev 被网络阻断

在中国大陆，`workers.dev` 可能被 DNS 污染或 TCP 阻断。典型现象：

- 域名能解析，但 IP 不是 Cloudflare 的地址；
- 连接一直超时；
- 换成手机流量、Wi-Fi 都一样。

这种情况下重新部署也没用，必须绑定自己的自定义域名，或改用 VPS。

### 确认是否 claim 成功

打开 Cloudflare Dashboard → Workers & Pages：

- 能看到 `soundbridge`：claim 成功，问题在域名可达性；
- 看不到：claim 没有完成或已经过期，需要用自己的账号重新部署。

## 常见问题

### 部署时报 Durable Objects 需要付费

在 Cloudflare 控制台开通 Workers Paid，或使用支持 SQLite Durable Objects 的免费额度。

### 网页能打开但共享失败

检查：

- 地址必须是 `https://`；
- 浏览器控制台是否有 WSS 连接错误；
- `/healthz` 是否返回 `ok`；
- 部署后是否访问的是最新版本。

### 手机部署时 `npx wrangler login` 打不开浏览器

复制终端里的授权链接，手动在手机浏览器打开；或使用 `termux-open-url`。

### 是否需要 cloudflared

不需要。Workers 本身就在 Cloudflare 边缘运行，没有本地服务需要暴露。
