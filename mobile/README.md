# 声桥手机共享端（Android）

这是声桥的 Android 采集端，用 **AudioPlaybackCapture** 采集其他应用正在播放的声音（小说、音乐、视频等），可以选择只监听某个应用并随时切换；声音编码成 Opus 后通过 WSS 发送到声桥服务器，由网页收听端播放。App 内还提供环绕式实时音频节奏和可选的麦克风混音。

## 安装

- 直接下载：[soundbridge-mobile.apk](../public/downloads/soundbridge-mobile.apk)
- 或从网站下载：**https://你的域名/downloads/soundbridge-mobile.apk**
- 要求：**Android 10（API 29）及以上**
- 当前提供的是 debug 签名 APK，适合个人安装测试；正式分发请用你自己的签名重新打包。

安装时 Android 会提示“未知来源应用”，需要允许当前浏览器/文件管理器安装。

## 使用

1. 打开 App，服务器地址默认是当前公网 HTTPS 地址；也可以改成你自己的地址。
2. 点击“创建房间”，把房间码或邀请链接发给收听方。
3. 可选：点击“监听应用”，选择只采集某个小说/音乐 App；共享过程中也可以随时切换。
4. 点击“开始共享”。
5. 允许录音权限和系统“录制/投放屏幕”权限。
6. 如需说话，打开“同时采集麦克风”；麦克风声音会与小说声音混合。
7. 回到小说软件播放音频；收听方网页会显示“正在共享”，并播放声音。

共享界面中央的环绕式节奏环会随手机输出声音实时变化；切换监听应用时会短暂重建采集通道。

App 会显示一个常驻通知，通知里可以直接停止共享。对方加入或断开时，界面会显示“对方：已连接/已断开”，同时弹出 Toast 和系统通知（需要允许通知权限）。

## 原理

```text
小说 App ──AudioPlaybackCapture──▶ AudioRecord
                                      │ PCM 16-bit / 48kHz / stereo
                                      ▼
                                  MediaCodec Opus 96kbps
                                      │ 20ms 包
                                      ▼
                                  OkHttp WebSocket
                                      │ WSS /ws
                                      ▼
                                  声桥服务器（二进制转发）
                                      │
                                      ▼
                                  网页收听端（WebCodecs 解码）
```

二进制帧格式与网页一致：

```text
byte 0      : version = 1
byte 1..8   : timestamp (float64 little-endian, 微秒)
byte 9..    : Opus payload
```

Android 端加入房间后会发送 relay-state=true，网页端会自动切换到中继模式；开始/停止采集时发送 state 消息。

## 构建

需要：

- JDK 17 或 21
- Android SDK Platform 34、Build Tools 34.0.0
- Gradle 8.9（或 Android Studio）

```powershell
$env:ANDROID_HOME = "C:\Android"
$env:JAVA_HOME = "C:\Program Files\Java\jdk-21.0.10"
cd mobile
.\gradlew assembleDebug
```

APK 输出：

```text
mobile/app/build/outputs/apk/debug/app-debug.apk
```

当前 APK 的 SHA-256：

```text
B14A6A3FA9BF02B748A5C89B4CE24F6C7AAB1F2221AED417D3BAA6FB3B4F7B62
```

## 限制

- **iOS 不能作为共享方**：iOS 不允许第三方 App 采集其他 App 的声音。iPhone 只能作为网页收听端。
- Android 10 以下没有 AudioPlaybackCapture。
- 目标应用可以通过 allowAudioPlaybackCapture="false" 禁止被采集；带 DRM 的应用通常采集到静音。这不是 App 能绕过的系统限制。
- 系统会显示屏幕/录音指示；声桥只使用音频，不保存画面。部分系统在锁屏后会停止录屏，建议共享时保持屏幕亮着。
- 部分国产 ROM 会额外限制后台录音/前台服务，需要在系统设置中允许自启动、后台运行和录音权限。
- 手机端只负责采集和发送，不负责播放对方声音。

## 源码

- MainActivity.java：连接房间、权限、UI
- RelayClient.java：WebSocket、JSON/二进制协议
- AudioCaptureService.java：MediaProjection + AudioPlaybackCapture + MediaCodec Opus
