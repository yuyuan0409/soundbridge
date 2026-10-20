package com.soundbridge.mobile;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.util.concurrent.TimeUnit;

import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Small WebSocket client shared by the Activity and the capture service.
 * It speaks the same JSON + binary protocol as the web client.
 */
public final class RelayClient {
    public interface Listener {
        void onOpen();
        void onMessage(JSONObject message);
        void onClosed(String reason);
        void onFailure(String error);
    }

    private static final RelayClient INSTANCE = new RelayClient();

    public static RelayClient get() {
        return INSTANCE;
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private OkHttpClient httpClient;
    private volatile WebSocket socket;
    private volatile Listener listener;
    private volatile int generation = 0;

    private RelayClient() {
    }

    public void setListener(Listener value) {
        listener = value;
    }

    public boolean isOpen() {
        return socket != null;
    }

    public void connect(String rawServer, Listener value) {
        listener = value;
        HttpUrl url = normalize(rawServer);
        if (url == null) {
            notifyFailure("服务器地址格式不正确");
            return;
        }

        close(false);
        final int generationAtConnect = ++generation;
        httpClient = new OkHttpClient.Builder()
                .pingInterval(20, TimeUnit.SECONDS)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .build();

        Request request = new Request.Builder().url(url).build();
        socket = httpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                if (generationAtConnect != generation) return;
                mainHandler.post(() -> {
                    Listener current = listener;
                    if (current != null) current.onOpen();
                });
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                if (generationAtConnect != generation) return;
                JSONObject object;
                try {
                    object = new JSONObject(text);
                } catch (Exception ignored) {
                    return;
                }
                mainHandler.post(() -> {
                    Listener current = listener;
                    if (current != null) current.onMessage(object);
                });
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                // The listening web client may also share audio. This app is a
                // sharing endpoint, so incoming relay audio is intentionally ignored.
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                if (generationAtConnect != generation) return;
                if (socket == webSocket) socket = null;
                mainHandler.post(() -> {
                    Listener current = listener;
                    if (current != null) current.onClosed(reason == null || reason.isEmpty() ? "连接已关闭" : reason);
                });
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (generationAtConnect != generation) return;
                if (socket == webSocket) socket = null;
                mainHandler.post(() -> {
                    Listener current = listener;
                    if (current != null) current.onFailure(t == null ? "网络连接失败" : t.getMessage());
                });
            }
        });
    }

    public boolean sendJson(JSONObject object) {
        WebSocket current = socket;
        return current != null && current.send(object.toString());
    }

    public boolean sendCreateRoom() {
        try {
            return sendJson(new JSONObject().put("type", "create"));
        } catch (Exception error) {
            return false;
        }
    }

    public boolean sendJoinRoom(String code) {
        try {
            return sendJson(new JSONObject().put("type", "join").put("room", code));
        } catch (Exception error) {
            return false;
        }
    }

    public boolean sendSharing(boolean sharing, boolean mic) {
        try {
            return sendJson(new JSONObject()
                    .put("type", "state")
                    .put("sharing", sharing)
                    .put("mic", mic));
        } catch (Exception error) {
            return false;
        }
    }

    public boolean sendRelayState(boolean active) {
        try {
            return sendJson(new JSONObject().put("type", "relay-state").put("active", active));
        } catch (Exception error) {
            return false;
        }
    }

    public boolean sendLeave() {
        try {
            return sendJson(new JSONObject().put("type", "leave"));
        } catch (Exception error) {
            return false;
        }
    }

    /**
     * Binary frame: [version=1][timestamp float64 little endian][opus payload].
     */
    public boolean sendAudio(byte[] payload, long timestampUs) {
        WebSocket current = socket;
        if (current == null || payload == null || payload.length == 0) return false;

        ByteBuffer buffer = ByteBuffer.allocate(9 + payload.length);
        buffer.put((byte) 1);
        buffer.putDouble(Math.max(0L, timestampUs));
        buffer.put(payload);
        return current.send(ByteString.of(buffer.array()));
    }

    public void close(boolean sendLeave) {
        generation += 1;
        WebSocket current = socket;
        socket = null;
        if (current != null) {
            if (sendLeave) {
                try {
                    current.send(new JSONObject().put("type", "leave").toString());
                } catch (Exception ignored) {
                }
            }
            try {
                current.close(1000, "bye");
            } catch (Exception ignored) {
            }
        }
        if (httpClient != null) {
            try {
                httpClient.dispatcher().executorService().shutdown();
            } catch (Exception ignored) {
            }
            httpClient = null;
        }
    }

    private void notifyFailure(String message) {
        mainHandler.post(() -> {
            Listener current = listener;
            if (current != null) current.onFailure(message);
        });
    }

    private HttpUrl normalize(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty()) return null;

        if (value.startsWith("wss://")) value = "https://" + value.substring(6);
        else if (value.startsWith("ws://")) value = "http://" + value.substring(5);
        else if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "https://" + value;
        }

        int query = value.indexOf('?');
        if (query >= 0) value = value.substring(0, query);
        int hash = value.indexOf('#');
        if (hash >= 0) value = value.substring(0, hash);
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);

        HttpUrl parsed = HttpUrl.parse(value);
        if (parsed == null) return null;

        String path = parsed.encodedPath();
        if (path == null || path.isEmpty() || "/".equals(path) || path.endsWith(".html")) {
            path = "/ws";
        } else if (!path.endsWith("/ws")) {
            path = path.replaceAll("/+$", "") + "/ws";
        }

        return parsed.newBuilder()
                .encodedPath(path)
                .query(null)
                .fragment(null)
                .build();
    }
}
