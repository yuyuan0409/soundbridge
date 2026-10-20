package com.soundbridge.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class MainActivity extends Activity implements RelayClient.Listener {
    private static final int REQUEST_PERMISSIONS = 2001;
    private static final int REQUEST_PROJECTION = 2002;
    private static final int REQUEST_NOTIFICATIONS = 2003;
    private static final String PREFS = "soundbridge";

    private final int colorInk = Color.rgb(7, 10, 16);
    private final int colorPanel = Color.rgb(18, 26, 40);
    private final int colorPanelSoft = Color.rgb(13, 19, 30);
    private final int colorCoral = Color.rgb(255, 122, 89);
    private final int colorTeal = Color.rgb(111, 227, 208);
    private final int colorPaper = Color.rgb(243, 241, 234);
    private final int colorMuted = Color.rgb(147, 157, 173);
    private final int colorDim = Color.rgb(94, 106, 122);

    private EditText serverInput;
    private EditText roomInput;
    private TextView statusView;
    private TextView peerStatusView;
    private TextView roomCodeView;
    private TextView inviteView;
    private TextView hintView;
    private Button createButton;
    private Button joinButton;
    private Button shareButton;
    private Button stopButton;
    private Button copyButton;
    private Button leaveButton;
    private Button targetAppButton;
    private Switch micSwitch;
    private RhythmView rhythmView;
    private int targetUid = -1;
    private String targetLabel = "全部应用";
    private boolean suppressMicEvent = false;

    private RelayClient relay;
    private String roomCode = "";
    private String inviteUrl = "";
    private String pendingAction = "";
    private boolean receiverRegistered = false;
    private boolean leaving = false;

    private final BroadcastReceiver captureStateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || !AudioCaptureService.ACTION_STATE.equals(intent.getAction())) return;
            boolean running = intent.getBooleanExtra(AudioCaptureService.EXTRA_RUNNING, false);
            boolean mic = intent.getBooleanExtra(AudioCaptureService.EXTRA_MIC, false);
            String message = intent.getStringExtra(AudioCaptureService.EXTRA_MESSAGE);
            if (message != null && !message.isEmpty()) statusView.setText(message);
            updateShareButtons(running);
            if (rhythmView != null) {
                if (running) rhythmView.setActive(true);
                else rhythmView.setRhythm(0f, 0f, false);
            }
            if (running) {
                syncMicSwitch(mic);
                saveSettings();
            }
        }
    };

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(colorInk);
        getWindow().setNavigationBarColor(colorInk);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        relay = RelayClient.get();
        relay.setListener(this);
        createEventNotificationChannel();

        buildUi();
        loadSettings();

        IntentFilter filter = new IntentFilter(AudioCaptureService.ACTION_STATE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(captureStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(captureStateReceiver, filter);
        }
        receiverRegistered = true;

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQUEST_NOTIFICATIONS
            );
        }

        updateShareButtons(AudioCaptureService.isRunning());
        if (AudioCaptureService.isRunning()) {
            syncMicSwitch(AudioCaptureService.isMicEnabled());
            setPeerStatus("对方：状态未知", colorDim);
            statusView.setText(AudioCaptureService.isMicEnabled()
                    ? "正在共享手机声音和麦克风"
                    : "正在共享手机声音");
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        AudioCaptureService.setRhythmListener((level, bass, active) -> runOnUiThread(() -> {
            if (rhythmView != null) rhythmView.setRhythm(level, bass, active);
        }));
        if (rhythmView != null) rhythmView.setActive(AudioCaptureService.isRunning());
    }

    @Override
    protected void onPause() {
        AudioCaptureService.setRhythmListener(null);
        if (rhythmView != null) rhythmView.setActive(false);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        AudioCaptureService.setRhythmListener(null);
        relay.setListener(null);
        if (receiverRegistered) {
            try {
                unregisterReceiver(captureStateReceiver);
            } catch (Exception ignored) {
            }
            receiverRegistered = false;
        }
        if (!AudioCaptureService.isRunning()) {
            relay.close(false);
        }
        super.onDestroy();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(colorInk);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(22), dp(22), dp(22), dp(28));
        scroll.addView(root, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT
        ));

        TextView brand = text("声桥 · 手机共享端", 28, colorPaper, Typeface.BOLD);
        brand.setLetterSpacing(0.04f);
        root.addView(brand);

        TextView subtitle = text("把手机里正在播放的小说、音乐或视频声音，实时送到收听房间。", 13, colorMuted, Typeface.NORMAL);
        subtitle.setLineSpacing(dp(4), 1f);
        root.addView(subtitle, topMargin(dp(8)));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(18), dp(16), dp(18), dp(18));
        card.setBackground(roundRect(colorPanel, 20, Color.rgb(40, 52, 72), 1));
        root.addView(card, topMargin(dp(22)));

        card.addView(label("服务器地址"));
        serverInput = input("https://你的声桥地址", false);
        serverInput.setText(getString(R.string.default_server));
        serverInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        card.addView(serverInput, topMargin(dp(7)));

        TextView serverHint = text("填写网页版的 HTTPS 地址；公网隧道地址可直接使用。", 10, colorDim, Typeface.NORMAL);
        card.addView(serverHint, topMargin(dp(6)));

        card.addView(label("房间"), topMargin(dp(16)));
        roomInput = input("6 位房间码", false);
        roomInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS);
        roomInput.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(6)});
        card.addView(roomInput, topMargin(dp(7)));

        LinearLayout roomActions = new LinearLayout(this);
        roomActions.setOrientation(LinearLayout.HORIZONTAL);
        createButton = button("创建房间", colorCoral, Color.rgb(29, 13, 8), false);
        joinButton = button("加入房间", colorPanelSoft, colorPaper, true);
        LinearLayout.LayoutParams createParams = new LinearLayout.LayoutParams(0, dp(48), 1f);
        createParams.rightMargin = dp(8);
        LinearLayout.LayoutParams joinParams = new LinearLayout.LayoutParams(0, dp(48), 1f);
        joinParams.leftMargin = dp(8);
        roomActions.addView(createButton, createParams);
        roomActions.addView(joinButton, joinParams);
        card.addView(roomActions, topMargin(dp(12)));

        LinearLayout roomBox = new LinearLayout(this);
        roomBox.setOrientation(LinearLayout.VERTICAL);
        roomBox.setPadding(dp(14), dp(12), dp(14), dp(12));
        roomBox.setBackground(roundRect(Color.rgb(10, 16, 25), 14, Color.rgb(38, 49, 68), 1));
        card.addView(roomBox, topMargin(dp(16)));

        TextView roomLabel = text("房间码", 9, colorDim, Typeface.NORMAL);
        roomLabel.setLetterSpacing(0.16f);
        roomBox.addView(roomLabel);

        roomCodeView = text("------", 30, colorPaper, Typeface.NORMAL);
        roomCodeView.setTypeface(Typeface.MONOSPACE);
        roomCodeView.setLetterSpacing(0.14f);
        roomCodeView.setTextIsSelectable(true);
        roomBox.addView(roomCodeView, topMargin(dp(2)));

        inviteView = text("创建或加入房间后，把邀请链接发给收听方。", 10, colorMuted, Typeface.NORMAL);
        inviteView.setTextIsSelectable(true);
        inviteView.setLineSpacing(dp(3), 1f);
        roomBox.addView(inviteView, topMargin(dp(6)));

        LinearLayout linkActions = new LinearLayout(this);
        linkActions.setOrientation(LinearLayout.HORIZONTAL);
        copyButton = button("复制邀请链接", colorPanelSoft, colorMuted, true);
        leaveButton = button("离开房间", colorPanelSoft, Color.rgb(255, 157, 140), true);
        LinearLayout.LayoutParams copyParams = new LinearLayout.LayoutParams(0, dp(42), 1f);
        copyParams.rightMargin = dp(6);
        LinearLayout.LayoutParams leaveParams = new LinearLayout.LayoutParams(0, dp(42), 1f);
        leaveParams.leftMargin = dp(6);
        linkActions.addView(copyButton, copyParams);
        linkActions.addView(leaveButton, leaveParams);
        roomBox.addView(linkActions, topMargin(dp(10)));

        statusView = text("尚未连接服务器", 12, colorTeal, Typeface.NORMAL);
        statusView.setLineSpacing(dp(3), 1f);
        root.addView(statusView, topMargin(dp(18)));

        peerStatusView = text("对方：未连接", 11, colorDim, Typeface.NORMAL);
        root.addView(peerStatusView, topMargin(dp(4)));

        startSection(root);

        hintView = text(
                "使用步骤\n" +
                        "1. 创建或加入房间，把邀请链接发给收听方\n" +
                        "2. 可选择“监听应用”，只采集小说/音乐 App\n" +
                        "3. 点击“开始共享”，允许系统屏幕/音频录制\n" +
                        "4. 如需说话，打开“同时采集麦克风”\n" +
                        "5. 回到小说软件播放音频，收听方即可听到\n\n" +
                        "说明：Android 10 及以上可用。系统只允许采集允许被录制的应用声音；部分版权/DRM 应用会主动禁止采集。如果锁屏后停止，请保持屏幕亮着。",
                11, colorMuted, Typeface.NORMAL);
        hintView.setLineSpacing(dp(4), 1f);
        hintView.setPadding(dp(2), 0, dp(2), 0);
        root.addView(hintView, topMargin(dp(18)));

        setContentView(scroll);

        createButton.setOnClickListener(v -> hideKeyboardAndCreate());
        joinButton.setOnClickListener(v -> hideKeyboardAndJoin());
        shareButton.setOnClickListener(v -> startSharing());
        stopButton.setOnClickListener(v -> stopSharing());
        copyButton.setOnClickListener(v -> copyInvite());
        leaveButton.setOnClickListener(v -> leaveRoom());
    }

    private void startSection(LinearLayout root) {
        LinearLayout section = new LinearLayout(this);
        section.setOrientation(LinearLayout.VERTICAL);
        section.setPadding(dp(18), dp(16), dp(18), dp(16));
        section.setBackground(roundRect(colorPanel, 20, Color.rgb(40, 52, 72), 1));

        TextView heading = text("共享手机应用声音", 15, colorPaper, Typeface.BOLD);
        section.addView(heading);
        TextView note = text("系统会显示“正在录制或投放屏幕”，这是安卓采集应用声音的必要条件。", 10, colorDim, Typeface.NORMAL);
        note.setLineSpacing(dp(3), 1f);
        section.addView(note, topMargin(dp(5)));

        rhythmView = new RhythmView(this);
        LinearLayout.LayoutParams rhythmParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(220)
        );
        section.addView(rhythmView, rhythmParams);

        targetAppButton = button("监听应用：全部应用", colorPanelSoft, colorMuted, true);
        targetAppButton.setSingleLine(true);
        targetAppButton.setEllipsize(TextUtils.TruncateAt.END);
        targetAppButton.setOnClickListener(v -> showAppPicker());
        section.addView(targetAppButton, topMargin(dp(4)));
        TextView appNote = text("只采集所选应用；共享中切换会短暂中断声音。", 9, colorDim, Typeface.NORMAL);
        section.addView(appNote, topMargin(dp(3)));

        micSwitch = new Switch(this);
        micSwitch.setText("同时采集麦克风");
        micSwitch.setTextSize(12);
        micSwitch.setTextColor(colorMuted);
        micSwitch.setPadding(0, dp(6), 0, 0);
        micSwitch.setThumbTintList(ColorStateList.valueOf(colorCoral));
        micSwitch.setTrackTintList(ColorStateList.valueOf(Color.rgb(55, 66, 84)));
        micSwitch.setChecked(false);
        micSwitch.setOnCheckedChangeListener((button, checked) -> {
            if (suppressMicEvent) return;
            saveSettings();
            if (AudioCaptureService.isRunning()) {
                Intent micIntent = new Intent(this, AudioCaptureService.class);
                micIntent.setAction(AudioCaptureService.ACTION_SET_MIC);
                micIntent.putExtra(AudioCaptureService.EXTRA_MIC, checked);
                startService(micIntent);
                statusView.setText(checked ? "正在开启麦克风…" : "正在关闭麦克风…");
            } else {
                statusView.setText(checked ? "开始共享时会同时采集麦克风" : "麦克风未开启");
            }
        });
        section.addView(micSwitch, topMargin(dp(8)));

        TextView micNote = text("说话声会与设备声音混合；建议戴耳机，减少回声。", 10, colorDim, Typeface.NORMAL);
        section.addView(micNote, topMargin(dp(2)));

        shareButton = button("开始共享", colorCoral, Color.rgb(29, 13, 8), false);
        stopButton = button("停止共享", colorPanelSoft, Color.rgb(255, 157, 140), true);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams shareParams = new LinearLayout.LayoutParams(0, dp(50), 1f);
        shareParams.rightMargin = dp(8);
        LinearLayout.LayoutParams stopParams = new LinearLayout.LayoutParams(0, dp(50), 1f);
        stopParams.leftMargin = dp(8);
        row.addView(shareButton, shareParams);
        row.addView(stopButton, stopParams);
        section.addView(row, topMargin(dp(13)));

        updateShareButtons(AudioCaptureService.isRunning());
        root.addView(section, topMargin(dp(16)));
    }

    private void updateShareButtons(boolean running) {
        if (shareButton == null || stopButton == null) return;
        boolean ready = !roomCode.isEmpty() && relay != null && relay.isOpen();
        shareButton.setEnabled(ready && !running);
        stopButton.setEnabled(running);
        shareButton.setAlpha(shareButton.isEnabled() ? 1f : 0.45f);
        stopButton.setAlpha(stopButton.isEnabled() ? 1f : 0.45f);
        if (!running) shareButton.setText("开始共享");
        else shareButton.setText("共享中");
    }

    private void hideKeyboardAndCreate() {
        hideKeyboard();
        if (!relay.isOpen()) {
            pendingAction = "create";
            connectToServer();
            return;
        }
        sendCreate();
    }

    private void hideKeyboardAndJoin() {
        hideKeyboard();
        String code = roomInput.getText().toString().trim().toUpperCase(Locale.ROOT);
        if (!code.matches("[A-HJ-NP-Z2-9]{6}")) {
            toast("请输入 6 位房间码（不含 0、1、I、O）");
            return;
        }
        if (!relay.isOpen()) {
            pendingAction = "join:" + code;
            connectToServer();
            return;
        }
        sendJoin(code);
    }

    private void connectToServer() {
        leaving = false;
        String server = normalizedBase();
        if (server.isEmpty()) {
            toast("请填写服务器地址");
            pendingAction = "";
            return;
        }
        saveSettings();
        statusView.setText("正在连接服务器…");
        relay.connect(server, this);
    }

    private void sendCreate() {
        if (!relay.sendCreateRoom()) {
            toast("无法发送创建房间请求");
            return;
        }
        statusView.setText("正在创建房间…");
    }

    private void sendJoin(String code) {
        if (!relay.sendJoinRoom(code)) {
            toast("无法发送加入房间请求");
            return;
        }
        statusView.setText("正在加入房间…");
    }

    private String normalizedBase() {
        String value = serverInput.getText().toString().trim();
        if (value.isEmpty()) return "";
        if (value.startsWith("wss://")) value = "https://" + value.substring(6);
        else if (value.startsWith("ws://")) value = "http://" + value.substring(5);
        else if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "https://" + value;
        }
        int query = value.indexOf('?');
        if (query >= 0) value = value.substring(0, query);
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    private void setRoom(String code) {
        roomCode = code == null ? "" : code;
        roomInput.setText(roomCode);
        roomCodeView.setText(roomCode.isEmpty() ? "------" : roomCode);
        String base = normalizedBase();
        inviteUrl = roomCode.isEmpty() || base.isEmpty() ? "" : base + "/?room=" + roomCode;
        inviteView.setText(inviteUrl.isEmpty()
                ? "创建或加入房间后，把邀请链接发给收听方。"
                : "邀请链接：" + inviteUrl);
        updateShareButtons(AudioCaptureService.isRunning());
        if (relay != null && relay.isOpen() && !roomCode.isEmpty()) {
            relay.sendRelayState(true);
            relay.sendSharing(AudioCaptureService.isRunning(), activeMic());
        }
    }

    private boolean activeMic() {
        return AudioCaptureService.isRunning() && AudioCaptureService.isMicEnabled();
    }

    private void syncMicSwitch(boolean checked) {
        if (micSwitch == null) return;
        suppressMicEvent = true;
        micSwitch.setChecked(checked);
        suppressMicEvent = false;
    }

    @Override
    public void onOpen() {
        statusView.setText("服务器已连接");
        if (pendingAction.startsWith("create")) {
            pendingAction = "";
            sendCreate();
        } else if (pendingAction.startsWith("join:")) {
            String code = pendingAction.substring(5);
            pendingAction = "";
            sendJoin(code);
        }
        updateShareButtons(AudioCaptureService.isRunning());
    }

    @Override
    public void onMessage(JSONObject message) {
        String type = message.optString("type");
        if ("created".equals(type) || "joined".equals(type)) {
            String code = message.optString("room");
            setRoom(code);
            boolean peerPresent = message.optJSONObject("peer") != null;
            setPeerStatus(
                    peerPresent ? "对方：已连接" : "对方：等待连接",
                    peerPresent ? colorTeal : colorDim
            );
            relay.sendRelayState(true);
            relay.sendSharing(AudioCaptureService.isRunning(), activeMic());
            if ("created".equals(type)) {
                statusView.setText("房间已创建，等待收听方加入");
            } else {
                statusView.setText("已加入房间，等待对方开始收听");
            }
            return;
        }

        if ("peer-joined".equals(type)) {
            setPeerStatus("对方：已连接", colorTeal);
            statusView.setText("对方已连接，可以开始共享");
            toast("对方已连接");
            notifyPeerEvent("对方已连接", "现在可以开始共享手机声音");
            return;
        }

        if ("peer-left".equals(type)) {
            setPeerStatus("对方：已断开", Color.rgb(255, 145, 125));
            statusView.setText(AudioCaptureService.isRunning()
                    ? "对方已断开，共享继续等待重连"
                    : "对方已断开连接");
            toast("对方已断开连接");
            notifyPeerEvent("对方已断开", "共享仍在继续，等待对方重新连接");
            return;
        }

        if ("peer-relay".equals(type)) {
            boolean active = message.optBoolean("active");
            if (active) statusView.setText("收听方已连接中继，可以开始共享");
            return;
        }

        if ("room-closed".equals(type)) {
            statusView.setText("房间已关闭");
            setPeerStatus("对方：房间已关闭", colorDim);
            setRoom("");
            if (AudioCaptureService.isRunning()) stopSharing();
            return;
        }

        if ("error".equals(type)) {
            String text = message.optString("message", "操作失败");
            statusView.setText(text);
            toast(text);
        }
    }

    @Override
    public void onClosed(String reason) {
        if (leaving) return;
        statusView.setText("连接已断开：" + reason);
        setPeerStatus("对方：连接已断开", Color.rgb(255, 145, 125));
        if (AudioCaptureService.isRunning()) stopSharing();
        updateShareButtons(AudioCaptureService.isRunning());
    }

    @Override
    public void onFailure(String error) {
        statusView.setText("连接失败：" + (error == null ? "未知错误" : error));
        setPeerStatus("对方：连接异常", Color.rgb(255, 145, 125));
        toast("连接失败，请检查服务器地址和网络");
        updateShareButtons(AudioCaptureService.isRunning());
    }

    private void startSharing() {
        if (roomCode.isEmpty()) {
            toast("请先创建或加入房间");
            return;
        }
        if (!relay.isOpen()) {
            toast("服务器连接已断开");
            return;
        }
        if (AudioCaptureService.isRunning()) {
            stopSharing();
            return;
        }

        List<String> missing = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.POST_NOTIFICATIONS);
        }

        if (!missing.isEmpty()) {
            requestPermissions(missing.toArray(new String[0]), REQUEST_PERMISSIONS);
            return;
        }
        requestProjection();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_NOTIFICATIONS) return;
        if (requestCode != REQUEST_PERMISSIONS) return;

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            toast("需要录音权限才能采集手机应用声音");
            return;
        }
        requestProjection();
    }

    private void requestProjection() {
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            toast("当前系统不支持屏幕/音频采集");
            return;
        }
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_PROJECTION);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_PROJECTION) return;
        if (resultCode != RESULT_OK || data == null) {
            statusView.setText("已取消共享");
            return;
        }

        Intent service = new Intent(this, AudioCaptureService.class);
        service.setAction(AudioCaptureService.ACTION_START);
        service.putExtra(AudioCaptureService.EXTRA_RESULT_CODE, resultCode);
        service.putExtra(AudioCaptureService.EXTRA_DATA, data);
        service.putExtra(AudioCaptureService.EXTRA_MIC, micSwitch != null && micSwitch.isChecked());
        service.putExtra(AudioCaptureService.EXTRA_TARGET_UID, targetUid);
        service.putExtra(AudioCaptureService.EXTRA_TARGET_LABEL, targetLabel);
        startForegroundService(service);
        statusView.setText("正在启动手机声音共享…");
    }

    private void stopSharing() {
        Intent service = new Intent(this, AudioCaptureService.class);
        service.setAction(AudioCaptureService.ACTION_STOP);
        try {
            startService(service);
        } catch (Exception ignored) {
            try {
                stopService(service);
            } catch (Exception ignoredAgain) {
            }
        }
        statusView.setText("正在停止共享…");
    }

    private void leaveRoom() {
        leaving = true;
        if (AudioCaptureService.isRunning()) stopSharing();
        relay.sendLeave();
        relay.close(false);
        setRoom("");
        setPeerStatus("对方：未连接", colorDim);
        statusView.setText("已离开房间");
    }

    private void copyInvite() {
        if (inviteUrl.isEmpty()) {
            toast("请先创建或加入房间");
            return;
        }
        ClipboardManager manager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (manager != null) {
            manager.setPrimaryClip(ClipData.newPlainText("声桥邀请链接", inviteUrl));
            toast("邀请链接已复制");
        }
    }

    private void loadSettings() {
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        String server = preferences.getString("server", "");
        if (!server.isEmpty()) serverInput.setText(server);
        String code = preferences.getString("room", "");
        if (!code.isEmpty()) roomInput.setText(code);
        syncMicSwitch(preferences.getBoolean("mic", false));
        targetUid = preferences.getInt("targetUid", -1);
        targetLabel = preferences.getString("targetLabel", "全部应用");
        if (targetAppButton != null) targetAppButton.setText("监听应用：" + targetLabel);
    }

    private void saveSettings() {
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        preferences.edit()
                .putString("server", normalizedBase())
                .putString("room", roomInput.getText().toString().trim())
                .putBoolean("mic", micSwitch != null && micSwitch.isChecked())
                .putInt("targetUid", targetUid)
                .putString("targetLabel", targetLabel)
                .apply();
    }

    private void hideKeyboard() {
        View view = getCurrentFocus();
        if (view == null) return;
        InputMethodManager manager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (manager != null) manager.hideSoftInputFromWindow(view.getWindowToken(), 0);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private LinearLayout.LayoutParams topMargin(int value) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = value;
        return params;
    }

    private TextView text(String value, float size, int color, int style) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setTypeface(Typeface.create("sans-serif", style));
        return view;
    }

    private TextView label(String value) {
        TextView view = text(value, 10, colorDim, Typeface.BOLD);
        view.setLetterSpacing(0.12f);
        return view;
    }

    private EditText input(String hint, boolean code) {
        EditText view = new EditText(this);
        view.setHint(hint);
        view.setHintTextColor(colorDim);
        view.setTextColor(colorPaper);
        view.setTextSize(14);
        view.setSingleLine(true);
        view.setPadding(dp(13), dp(10), dp(13), dp(10));
        view.setBackground(roundRect(Color.rgb(10, 16, 25), 12, Color.rgb(38, 49, 68), 1));
        return view;
    }

    private Button button(String label, int background, int foreground, boolean border) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(13);
        button.setAllCaps(false);
        button.setTextColor(foreground);
        button.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        int stroke = border ? Color.rgb(50, 63, 82) : Color.rgb(255, 164, 136);
        button.setBackground(roundRect(background, 13, stroke, 1));
        button.setPadding(dp(12), 0, dp(12), 0);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        return button;
    }

    private void showAppPicker() {
        PackageManager manager = getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN);
        launcher.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolved = manager.queryIntentActivities(launcher, 0);

        List<AppChoice> apps = new ArrayList<>();
        Set<Integer> seen = new HashSet<>();
        int ownUid = getApplicationInfo().uid;
        for (ResolveInfo item : resolved) {
            ApplicationInfo info = item.activityInfo == null ? null : item.activityInfo.applicationInfo;
            if (info == null || info.uid == ownUid) continue;
            if (!seen.add(info.uid)) continue;
            String label = String.valueOf(info.loadLabel(manager));
            apps.add(new AppChoice(info.uid, label));
        }
        apps.sort(Comparator.comparing(choice -> choice.label.toLowerCase(Locale.ROOT)));

        String[] labels = new String[apps.size() + 1];
        labels[0] = "全部应用";
        for (int index = 0; index < apps.size(); index++) {
            labels[index + 1] = apps.get(index).label;
        }

        new AlertDialog.Builder(this)
                .setTitle("选择要监听的应用")
                .setItems(labels, (dialog, which) -> {
                    if (which == 0) {
                        selectTargetApp(-1, "全部应用");
                    } else {
                        AppChoice choice = apps.get(which - 1);
                        selectTargetApp(choice.uid, choice.label);
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void selectTargetApp(int uid, String label) {
        targetUid = uid;
        targetLabel = label;
        if (targetAppButton != null) {
            targetAppButton.setText("监听应用：" + label);
        }
        saveSettings();

        if (AudioCaptureService.isRunning()) {
            Intent intent = new Intent(this, AudioCaptureService.class);
            intent.setAction(AudioCaptureService.ACTION_SET_TARGET);
            intent.putExtra(AudioCaptureService.EXTRA_TARGET_UID, uid);
            intent.putExtra(AudioCaptureService.EXTRA_TARGET_LABEL, label);
            startService(intent);
            statusView.setText("正在切换到：" + label + "…");
        } else {
            statusView.setText("共享时将监听：" + label);
        }
    }

    private static final class AppChoice {
        final int uid;
        final String label;

        AppChoice(int uid, String label) {
            this.uid = uid;
            this.label = label;
        }
    }

    private void setPeerStatus(String text, int color) {
        if (peerStatusView != null) {
            peerStatusView.setText(text);
            peerStatusView.setTextColor(color);
        }
    }

    private void createEventNotificationChannel() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                "soundbridge_events",
                "连接提醒",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("对方连接、断开或房间状态变化时提醒");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 120, 70, 120});
        manager.createNotificationChannel(channel);
    }

    private void notifyPeerEvent(String title, String detail) {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        try {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            Intent openIntent = new Intent(this, MainActivity.class);
            PendingIntent openPending = PendingIntent.getActivity(
                    this, 3, openIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            Notification.Builder builder = new Notification.Builder(this, "soundbridge_events")
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(title)
                    .setContentText(detail)
                    .setContentIntent(openPending)
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(false)
                    .setPriority(Notification.PRIORITY_HIGH)
                    .setDefaults(Notification.DEFAULT_ALL);
            manager.notify(60, builder.build());
        } catch (Exception ignored) {
        }
    }

    private GradientDrawable roundRect(int fill, int radiusDp, int strokeColor, int strokeWidthDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeWidthDp > 0) drawable.setStroke(dp(strokeWidthDp), strokeColor);
        return drawable;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}