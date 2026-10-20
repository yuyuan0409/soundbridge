package com.soundbridge.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Captures Android app playback with AudioPlaybackCapture, optionally mixes in
 * the microphone, encodes the result as Opus, and sends frames over WebSocket.
 */
public class AudioCaptureService extends Service {
    public static final String ACTION_START = "com.soundbridge.mobile.action.START";
    public static final String ACTION_STOP = "com.soundbridge.mobile.action.STOP";
    public static final String ACTION_SET_MIC = "com.soundbridge.mobile.action.SET_MIC";
    public static final String ACTION_SET_TARGET = "com.soundbridge.mobile.action.SET_TARGET";
    public static final String ACTION_STATE = "com.soundbridge.mobile.action.STATE";
    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_DATA = "data";
    public static final String EXTRA_RUNNING = "running";
    public static final String EXTRA_MIC = "mic";
    public static final String EXTRA_TARGET_UID = "targetUid";
    public static final String EXTRA_TARGET_LABEL = "targetLabel";
    public static final String EXTRA_MESSAGE = "message";

    private static final String TAG = "SoundBridgeCapture";
    private static final String CHANNEL_ID = "soundbridge_capture";
    private static final int NOTIFICATION_ID = 51;
    private static final int SAMPLE_RATE = 48_000;
    private static final int SYSTEM_CHANNELS = 2;
    private static final int SYSTEM_BYTES_PER_FRAME = 2 * SYSTEM_CHANNELS;
    private static final int MIC_CHANNELS = 1;
    private static final int MIC_BYTES_PER_FRAME = 2 * MIC_CHANNELS;

    private static volatile boolean running = false;
    private static volatile boolean micEnabled = false;

    public interface RhythmListener {
        void onRhythm(float level, float bass, boolean active);
    }

    private static volatile RhythmListener rhythmListener;

    public static void setRhythmListener(RhythmListener listener) {
        rhythmListener = listener;
    }

    public static boolean isRunning() {
        return running;
    }

    public static boolean isMicEnabled() {
        return micEnabled;
    }

    private final AtomicBoolean stopping = new AtomicBoolean(false);
    private MediaProjection projection;
    private MediaProjection.Callback projectionCallback;
    private volatile AudioRecord systemRecord;
    private AudioRecord micRecord;
    private AcousticEchoCanceler echoCanceler;
    private MediaCodec encoder;
    private Thread captureThread;
    private PowerManager.WakeLock wakeLock;
    private volatile boolean micRequested = false;
    private volatile int targetUid = -1;
    private int appliedTargetUid = -2;
    private volatile String targetLabel = "全部应用";
    private float currentLevel = 0f;
    private float currentBass = 0f;
    private long lastRhythmAt = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;

        if (ACTION_STOP.equals(intent.getAction())) {
            stopCapture("已停止共享");
            return START_NOT_STICKY;
        }

        if (ACTION_SET_MIC.equals(intent.getAction())) {
            if (!running) {
                stopSelf();
                return START_NOT_STICKY;
            }
            setMicRequested(intent.getBooleanExtra(EXTRA_MIC, false));
            return START_NOT_STICKY;
        }

        if (ACTION_SET_TARGET.equals(intent.getAction())) {
            if (!running) {
                stopSelf();
                return START_NOT_STICKY;
            }
            targetUid = intent.getIntExtra(EXTRA_TARGET_UID, -1);
            targetLabel = intent.getStringExtra(EXTRA_TARGET_LABEL);
            if (targetLabel == null || targetLabel.isEmpty()) targetLabel = "全部应用";
            broadcast(true, "正在切换到：" + targetLabel, micEnabled);
            return START_NOT_STICKY;
        }

        if (!ACTION_START.equals(intent.getAction())) return START_NOT_STICKY;
        if (running) return START_NOT_STICKY;

        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent data = intent.getParcelableExtra(EXTRA_DATA);
        if (resultCode == 0 || data == null) {
            broadcast(false, "没有拿到屏幕共享授权", false);
            stopSelf();
            return START_NOT_STICKY;
        }

        micRequested = intent.getBooleanExtra(EXTRA_MIC, false);
        micEnabled = micRequested;
        targetUid = intent.getIntExtra(EXTRA_TARGET_UID, -1);
        targetLabel = intent.getStringExtra(EXTRA_TARGET_LABEL);
        if (targetLabel == null || targetLabel.isEmpty()) targetLabel = "全部应用";
        appliedTargetUid = -2;

        try {
            startForeground(NOTIFICATION_ID, buildNotification("正在准备手机声音共享…"),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } catch (Exception error) {
            Log.e(TAG, "startForeground failed", error);
            broadcast(false, "无法启动前台共享服务：" + error.getMessage(), false);
            stopSelf();
            return START_NOT_STICKY;
        }

        MediaProjectionManager manager =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            broadcast(false, "系统不支持 MediaProjection", false);
            stopSelf();
            return START_NOT_STICKY;
        }

        projection = manager.getMediaProjection(resultCode, data);
        if (projection == null) {
            broadcast(false, "屏幕共享授权已失效，请重试", false);
            stopSelf();
            return START_NOT_STICKY;
        }

        projectionCallback = new MediaProjection.Callback() {
            @Override
            public void onStop() {
                stopCapture("系统已停止屏幕共享");
            }
        };
        projection.registerCallback(projectionCallback, new Handler(Looper.getMainLooper()));

        running = true;
        stopping.set(false);
        acquireWakeLock();
        captureThread = new Thread(this::captureLoop, "soundbridge-audio-capture");
        captureThread.start();
        String startMessage = (micRequested ? "正在共享手机声音和麦克风" : "正在共享手机应用声音")
                + " · " + targetLabel;
        broadcast(true, startMessage, micRequested);
        updateNotification(startMessage);
        return START_NOT_STICKY;
    }

    private void setMicRequested(boolean enabled) {
        micRequested = enabled;
        micEnabled = enabled;
        broadcast(true, enabled ? "麦克风已开启，声音正在混入" : "麦克风已关闭", enabled);
        updateNotification(enabled ? "正在共享手机声音和麦克风" : "正在共享手机应用声音");
        RelayClient.get().sendSharing(true, enabled);
    }

    @SuppressLint("MissingPermission")
    private void captureLoop() {
        try {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                throw new SecurityException("没有录音权限");
            }

            systemRecord = openSystemRecord(targetUid);
            appliedTargetUid = targetUid;

            encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
            MediaFormat outputFormat = MediaFormat.createAudioFormat(
                    MediaFormat.MIMETYPE_AUDIO_OPUS,
                    SAMPLE_RATE,
                    SYSTEM_CHANNELS
            );
            outputFormat.setInteger(MediaFormat.KEY_BIT_RATE, 96_000);
            outputFormat.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384);
            encoder.configure(outputFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            encoder.start();

            syncMicRecord();
            RelayClient.get().sendRelayState(true);
            RelayClient.get().sendSharing(true, micEnabled);
            broadcast(true, micEnabled ? "正在共享手机声音和麦克风" : "正在共享手机应用声音", micEnabled);

            byte[] systemPcm = new byte[1_024];
            byte[] micPcm = new byte[512];
            byte[] mixedPcm = new byte[1_024];
            MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();
            long framesWritten = 0;

            while (running && !Thread.currentThread().isInterrupted()) {
                syncSystemRecord();
                syncMicRecord();

                int systemRead = systemRecord.read(systemPcm, 0, systemPcm.length);
                if (systemRead <= 0) {
                    if (systemRead == AudioRecord.ERROR_DEAD_OBJECT) break;
                    continue;
                }

                int usable = systemRead - (systemRead % SYSTEM_BYTES_PER_FRAME);
                if (usable <= 0) continue;
                int frames = usable / SYSTEM_BYTES_PER_FRAME;

                int micRead = 0;
                if (micRecord != null && micEnabled) {
                    int wanted = Math.min(micPcm.length, frames * MIC_BYTES_PER_FRAME);
                    micRead = micRecord.read(micPcm, 0, wanted);
                }

                mixPcm(systemPcm, usable, micPcm, micRead, mixedPcm);

                int inputIndex = encoder.dequeueInputBuffer(10_000);
                if (inputIndex >= 0) {
                    ByteBuffer input = encoder.getInputBuffer(inputIndex);
                    if (input != null) {
                        input.clear();
                        input.put(mixedPcm, 0, usable);
                        long presentationTimeUs = framesWritten * 1_000_000L / SAMPLE_RATE;
                        encoder.queueInputBuffer(inputIndex, 0, usable, presentationTimeUs, 0);
                        framesWritten += frames;
                    }
                }

                drainEncoder(bufferInfo);
            }

            drainEncoder(bufferInfo);
        } catch (Throwable error) {
            Log.e(TAG, "capture failed", error);
            broadcast(false, "共享失败：" + (error.getMessage() == null ? "未知错误" : error.getMessage()), false);
            stopCapture("共享失败");
        }
    }

    @SuppressLint("MissingPermission")
    private AudioRecord openSystemRecord(int uid) {
        AudioPlaybackCaptureConfiguration.Builder configuration =
                new AudioPlaybackCaptureConfiguration.Builder(projection);
        if (uid >= 0) {
            configuration.addMatchingUid(uid);
        } else {
            configuration
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_GAME)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .addMatchingUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY);
        }

        AudioFormat format = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                .build();

        int minBuffer = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_STEREO,
                AudioFormat.ENCODING_PCM_16BIT
        );
        int bufferSize = Math.max(minBuffer * 2, 16_384);

        AudioRecord record = new AudioRecord.Builder()
                .setAudioFormat(format)
                .setBufferSizeInBytes(bufferSize)
                .setAudioPlaybackCaptureConfig(configuration.build())
                .build();

        if (record.getState() != AudioRecord.STATE_INITIALIZED) {
            try {
                record.release();
            } catch (Exception ignored) {
            }
            throw new IllegalStateException("AudioRecord 初始化失败，设备可能不支持应用声音采集");
        }

        record.startRecording();
        if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
            try {
                record.stop();
                record.release();
            } catch (Exception ignored) {
            }
            throw new IllegalStateException("无法开始采集手机声音");
        }
        return record;
    }

    private void syncSystemRecord() {
        if (!running) return;
        if (systemRecord != null && appliedTargetUid == targetUid) return;

        AudioRecord previous = systemRecord;
        systemRecord = null;
        if (previous != null) {
            try {
                previous.stop();
            } catch (Exception ignored) {
            }
            try {
                previous.release();
            } catch (Exception ignored) {
            }
        }

        systemRecord = openSystemRecord(targetUid);
        appliedTargetUid = targetUid;
        broadcast(true, "正在监听：" + targetLabel, micEnabled);
    }

    private void emitRhythm() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastRhythmAt < 60) return;
        lastRhythmAt = now;
        RhythmListener listener = rhythmListener;
        if (listener != null) listener.onRhythm(currentLevel, currentBass, true);
    }

    private void emitRhythmStopped() {
        RhythmListener listener = rhythmListener;
        if (listener != null) listener.onRhythm(0f, 0f, false);
    }

    private void mixPcm(byte[] systemPcm, int systemBytes, byte[] micPcm, int micBytes, byte[] output) {
        int frames = systemBytes / SYSTEM_BYTES_PER_FRAME;
        int micFrames = Math.max(0, micBytes / MIC_BYTES_PER_FRAME);
        double sum = 0;
        double low = 0;
        double lowSum = 0;
        for (int frame = 0; frame < frames; frame++) {
            int systemOffset = frame * SYSTEM_BYTES_PER_FRAME;
            int systemLeft = readShort(systemPcm, systemOffset);
            int systemRight = readShort(systemPcm, systemOffset + 2);
            int mic = 0;
            if (frame < micFrames) {
                mic = readShort(micPcm, frame * MIC_BYTES_PER_FRAME);
            }

            int left = clamp((int) (systemLeft * 0.9f + mic * 0.8f));
            int right = clamp((int) (systemRight * 0.9f + mic * 0.8f));
            writeShort(output, systemOffset, left);
            writeShort(output, systemOffset + 2, right);

            double mono = (left + right) / (2.0 * 32768.0);
            sum += mono * mono;
            low += (mono - low) * 0.04;
            lowSum += low * low;
        }

        if (frames > 0) {
            currentLevel = (float) Math.min(1.0, Math.sqrt(sum / frames) * 2.4);
            currentBass = (float) Math.min(1.0, Math.sqrt(lowSum / frames) * 4.2);
            emitRhythm();
        }
    }

    private int readShort(byte[] data, int offset) {
        if (offset + 1 >= data.length) return 0;
        return (short) ((data[offset] & 0xff) | (data[offset + 1] << 8));
    }

    private void writeShort(byte[] data, int offset, int value) {
        data[offset] = (byte) (value & 0xff);
        data[offset + 1] = (byte) ((value >> 8) & 0xff);
    }

    private int clamp(int value) {
        if (value > 32767) return 32767;
        if (value < -32768) return -32768;
        return value;
    }

    private void syncMicRecord() {
        if (!running) return;

        if (micRequested && micRecord == null) {
            if (openMicRecord()) {
                micEnabled = true;
                RelayClient.get().sendSharing(true, true);
                broadcast(true, "麦克风已开启，声音正在混入", true);
                updateNotification("正在共享手机声音和麦克风");
            } else {
                micRequested = false;
                micEnabled = false;
                RelayClient.get().sendSharing(true, false);
                broadcast(true, "麦克风不可用，继续共享手机声音", false);
            }
            return;
        }

        if (!micRequested && micRecord != null) {
            closeMicRecord();
            micEnabled = false;
            RelayClient.get().sendSharing(true, false);
            broadcast(true, "麦克风已关闭", false);
            updateNotification("正在共享手机应用声音");
        }
    }

    @SuppressLint("MissingPermission")
    private boolean openMicRecord() {
        try {
            AudioFormat micFormat = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build();

            int minBuffer = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT
            );
            int bufferSize = Math.max(minBuffer * 2, 8_192);

            micRecord = new AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.MIC)
                    .setAudioFormat(micFormat)
                    .setBufferSizeInBytes(bufferSize)
                    .build();

            if (micRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                closeMicRecord();
                return false;
            }

            micRecord.startRecording();
            if (micRecord.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                closeMicRecord();
                return false;
            }

            try {
                if (AcousticEchoCanceler.isAvailable()) {
                    echoCanceler = AcousticEchoCanceler.create(micRecord.getAudioSessionId());
                    if (echoCanceler != null) echoCanceler.setEnabled(true);
                }
            } catch (Exception ignored) {
            }
            return true;
        } catch (Exception error) {
            Log.e(TAG, "mic open failed", error);
            closeMicRecord();
            return false;
        }
    }

    private void closeMicRecord() {
        try {
            if (echoCanceler != null) {
                echoCanceler.setEnabled(false);
                echoCanceler.release();
            }
        } catch (Exception ignored) {
        }
        echoCanceler = null;

        if (micRecord != null) {
            try {
                micRecord.stop();
            } catch (Exception ignored) {
            }
            try {
                micRecord.release();
            } catch (Exception ignored) {
            }
        }
        micRecord = null;
    }

    private void drainEncoder(MediaCodec.BufferInfo info) {
        if (encoder == null) return;
        while (running) {
            int outputIndex;
            try {
                outputIndex = encoder.dequeueOutputBuffer(info, 0);
            } catch (Exception error) {
                break;
            }

            if (outputIndex == MediaCodec.INFO_TRY_AGAIN_LATER) break;
            if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue;
            if (outputIndex < 0) continue;

            try {
                ByteBuffer output = encoder.getOutputBuffer(outputIndex);
                if (output != null && info.size > 0
                        && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                    output.position(info.offset);
                    byte[] payload = new byte[info.size];
                    output.get(payload);
                    RelayClient.get().sendAudio(payload, info.presentationTimeUs);
                }
            } finally {
                try {
                    encoder.releaseOutputBuffer(outputIndex, false);
                } catch (Exception ignored) {
                }
            }

            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
        }
    }

    private void stopCapture(String message) {
        if (Looper.myLooper() == Looper.getMainLooper() && captureThread != null) {
            new Thread(() -> stopCapture(message), "soundbridge-stop").start();
            return;
        }
        if (!stopping.compareAndSet(false, true)) return;

        boolean wasRunning = running;
        running = false;
        micRequested = false;
        micEnabled = false;
        emitRhythmStopped();

        try {
            if (systemRecord != null) systemRecord.stop();
        } catch (Exception ignored) {
        }
        try {
            if (micRecord != null) micRecord.stop();
        } catch (Exception ignored) {
        }

        Thread thread = captureThread;
        captureThread = null;
        if (thread != null && thread != Thread.currentThread()
                && Looper.myLooper() != Looper.getMainLooper()) {
            try {
                thread.join(1_500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }

        if (wasRunning) {
            try {
                RelayClient.get().sendSharing(false, false);
            } catch (Exception ignored) {
            }
        }

        closeMicRecord();

        try {
            if (systemRecord != null) systemRecord.release();
        } catch (Exception ignored) {
        }
        systemRecord = null;

        try {
            if (encoder != null) {
                encoder.stop();
                encoder.release();
            }
        } catch (Exception ignored) {
        }
        encoder = null;

        if (projection != null && projectionCallback != null) {
            try {
                projection.unregisterCallback(projectionCallback);
            } catch (Exception ignored) {
            }
        }
        if (projection != null) {
            try {
                projection.stop();
            } catch (Exception ignored) {
            }
        }
        projection = null;
        projectionCallback = null;

        releaseWakeLock();

        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
        }
        broadcast(false, message == null ? "共享已停止" : message, false);
        stopSelf();
    }

    private void broadcast(boolean isRunning, String message, boolean mic) {
        Intent intent = new Intent(ACTION_STATE);
        intent.setPackage(getPackageName());
        intent.putExtra(EXTRA_RUNNING, isRunning);
        intent.putExtra(EXTRA_MESSAGE, message);
        intent.putExtra(EXTRA_MIC, mic);
        sendBroadcast(intent);
    }

    private void createNotificationChannel() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "手机声音共享",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("声桥正在采集手机应用声音");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent openPending = PendingIntent.getActivity(
                this, 1, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, AudioCaptureService.class).setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
                this, 2, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID);
        return builder
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("声桥正在共享手机声音")
                .setContentText(text)
                .setContentIntent(openPending)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(
                        Icon.createWithResource(this, R.drawable.ic_notification),
                        "停止共享",
                        stopPending
                ).build())
                .build();
    }

    private void updateNotification(String text) {
        try {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(text));
        } catch (Exception ignored) {
        }
    }

    private void acquireWakeLock() {
        try {
            PowerManager manager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (manager == null) return;
            wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SoundBridge:Capture");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(6 * 60 * 60 * 1000L);
        } catch (Exception ignored) {
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
        }
        wakeLock = null;
    }

    @Override
    public void onDestroy() {
        stopCapture("共享已停止");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
