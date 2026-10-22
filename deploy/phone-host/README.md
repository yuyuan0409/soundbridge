# 手机主机：Termux + ngrok

让 Android 手机自己运行 SoundBridge 服务，不需要电脑，也不需要开机自启。

## 先理解

- 手机需要装 Termux（F-Droid）
- 手机需要装 ngrok，并注册一个免费账号
- 手机必须保持开机、联网、别被省电模式杀掉
- 每次使用手动运行一个脚本
- ngrok 免费账号会分配一个固定的开发域名，例如 `abc123.ngrok-free.dev`
- 不是纯 APK；Termux 是独立的终端 App

## 一、安装 Termux

从 **F-Droid** 安装 Termux：

https://f-droid.org/packages/com.termux/

不要从 Google Play 安装旧版 Termux。

安装后打开 Termux，执行：

    pkg update
    pkg install -y curl
    bash -c "$(curl -fsSL https://raw.githubusercontent.com/yuyuan0409/soundbridge/main/deploy/phone-host/install.sh)"

安装脚本会：

1. 安装 Node、Git、wget
2. 下载项目到 `~/soundbridge`
3. 安装 npm 依赖
4. 下载 ngrok ARM64 版本
5. 让你输入 ngrok Authtoken 和免费 dev domain
6. 保存配置到 `~/.soundbridge-phone.env`

## 二、注册 ngrok 免费账号

1. 打开 https://dashboard.ngrok.com/signup
2. 注册并登录
3. 打开 https://dashboard.ngrok.com/get-started/your-authtoken
4. 复制 Authtoken
5. 打开 https://dashboard.ngrok.com/domains
6. 复制你的免费域名，例如：

    abc123.ngrok-free.dev

把这两个值填进安装脚本的提示里。

## 三、启动

在 Termux 里执行：

    bash ~/soundbridge/deploy/phone-host/start.sh

成功后终端会显示：

    https://abc123.ngrok-free.dev

把这个地址：

- 发给收听方
- 填进 Android 共享端 App 的“服务器地址”

按 `Ctrl+C` 停止服务。

## 四、手机设置

- 设置 → 应用 → Termux → 电池 → **不限制 / 允许后台活动**
- 保持手机插电
- 关闭省电模式对 Termux 的限制
- 使用期间不要清理后台
- 尽量不要和共享 APK 同时抢资源；如果手机性能足够可以同时运行

不需要安装 Termux:Boot，因为不要求开机自启。

## 五、ngrok 免费版提示

免费 ngrok 第一次用浏览器打开时，可能出现一个 ngrok 警告页：

- 点击 **Visit Site** 即可
- 之后同一浏览器一般不会重复出现

如果页面打不开，检查 Termux 里脚本是否还在运行。

## 六、可选：桌面一键启动

安装 Termux:Widget 后：

    mkdir -p ~/.shortcuts
    ln -sf ~/soundbridge/deploy/phone-host/start.sh ~/.shortcuts/soundbridge

然后在桌面添加 Termux 小部件，点一下就启动。

## 七、常见问题

### 提示 ngrok 不存在

重新运行安装脚本，或检查 `~/ngrok` 是否存在。

### 地址能打开但没声音

- 确认 Android 共享端服务器的地址是同一个 ngrok 地址
- 确认 App 已开始共享
- 浏览器点一下页面，允许播放声音

### 手机锁屏后断

Android 会限制后台。关闭电池优化、保持插电、运行 `termux-wake-lock`；启动脚本已经尝试获取 wake lock。

### ngrok 提示域名被占用

dev domain 是绑定账号的；在 ngrok Dashboard 的 Domains 页面复制正确域名。

## 限制

- 手机必须一直在线
- 免费 ngrok 有连接数和带宽限制
- 手机性能和电池是瓶颈
- 这不是纯 APK；是 Termux 里的服务
- URL 固定，但依赖 ngrok 免费域名政策
