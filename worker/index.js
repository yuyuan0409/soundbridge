/**
 * 声桥 Cloudflare Workers 版本
 *
 * - 静态文件由 Workers Assets 提供
 * - /ws 信令、房间状态、Opus 二进制中继由 RoomHub Durable Object 处理
 * - 所有房间放在一个全局 RoomHub 中；适合两人房间的小规模使用
 */

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const MAX_ROOM_SIZE = 2;
const MAX_ROOMS = 5000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_BINARY_BYTES = 16 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), display-capture=(self)',
};

function jsonResponse(payload, status = 200, extraHeaders = {}, head = false) {
  const body = head ? null : JSON.stringify(payload);
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  if (body !== null) headers.set('Content-Length', String(new TextEncoder().encode(body).byteLength));
  return new Response(body, { status, headers });
}

function withSecurityHeaders(response, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries({ ...SECURITY_HEADERS, ...extraHeaders })) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseStunUrls(env) {
  return String(env.STUN_URLS || 'stun:stun.l.google.com:19302')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function publicConfig(env, url) {
  const stunUrls = parseStunUrls(env);
  const publicUrl = String(env.CF_PUBLIC_URL || url.origin).replace(/\/+$/, '');
  return {
    iceServers: stunUrls.length ? [{ urls: stunUrls }] : [],
    secure: true,
    turnEnabled: false,
    relayEnabled: true,
    publicUrl,
    httpsPort: null,
    lanUrls: [],
    version: '1.0.0',
  };
}

async function serveAsset(request, env, url) {
  if (!env.ASSETS) {
    return jsonResponse({ error: 'ASSETS_NOT_CONFIGURED', message: '静态资源未配置' }, 500);
  }

  let assetPath = url.pathname;
  if (assetPath === '/favicon.ico') assetPath = '/icon.svg';
  if (assetPath === '/') assetPath = '/index.html';
  if (assetPath.endsWith('/')) assetPath += 'index.html';
  const assetUrl = new URL(url.toString());
  assetUrl.pathname = assetPath;

  const assetRequest = new Request(assetUrl.toString(), {
    method: request.method,
    headers: request.headers,
  });
  const assetResponse = await env.ASSETS.fetch(assetRequest);
  if (assetResponse.status === 404) {
    return jsonResponse(
      { error: 'NOT_FOUND', message: '页面不存在' },
      404,
      {},
      request.method === 'HEAD',
    );
  }

  const headers = new Headers(assetResponse.headers);
  headers.set('Cache-Control', assetPath === '/' || assetPath.endsWith('/index.html') ? 'no-store' : 'no-cache');
  if (assetPath.endsWith('.apk')) {
    headers.set('Content-Type', 'application/vnd.android.package-archive');
  }
  if (url.protocol === 'https:') {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse(
        { error: 'METHOD_NOT_ALLOWED', message: '只支持 GET 请求' },
        405,
        { Allow: 'GET, HEAD' },
      );
    }

    if (url.pathname === '/ws') {
      if (String(request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return jsonResponse(
          { error: 'UPGRADE_REQUIRED', message: '请使用 WebSocket 连接' },
          426,
        );
      }
      const id = env.ROOMS.idFromName('global');
      return env.ROOMS.get(id).fetch(request);
    }

    if (url.pathname === '/healthz') {
      try {
        const id = env.ROOMS.idFromName('global');
        const hubResponse = await env.ROOMS.get(id).fetch('https://room-hub/health');
        const health = await hubResponse.json();
        return jsonResponse(
          { ...health, secure: true, edge: true },
          200,
          {},
          request.method === 'HEAD',
        );
      } catch (error) {
        return jsonResponse(
          { ok: false, error: 'HUB_UNAVAILABLE', message: String(error && error.message || error) },
          503,
        );
      }
    }

    if (url.pathname === '/api/config') {
      return jsonResponse(publicConfig(env, url), 200, {}, request.method === 'HEAD');
    }

    return serveAsset(request, env, url);
  },
};

function randomRoomCode(rooms) {
  for (;;) {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    let code = '';
    for (const value of bytes) code += ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
}

function defaultPeerState() {
  return { sharing: false, mic: false, relay: false };
}

function peerInfo(meta) {
  return {
    id: meta.id,
    sharing: Boolean(meta.state.sharing),
    mic: Boolean(meta.state.mic),
    relay: Boolean(meta.state.relay),
  };
}

export class RoomHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();
    this.rateBuckets = new Map();
    this.startedAt = Date.now();
  }

  send(ws, payload) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    } catch {
      // 连接已经断开，交给 close 事件清理。
    }
  }

  sendError(ws, code, message) {
    this.send(ws, { type: 'error', code, message });
  }

  otherPeer(room, peerId) {
    for (const peer of room.peers.values()) {
      if (peer.meta.id !== peerId) return peer;
    }
    return null;
  }

  allowRate(ip, bucket, limit, windowMs) {
    const key = ip + ':' + bucket;
    const now = Date.now();
    let entry = this.rateBuckets.get(key);
    if (!entry || now - entry.startedAt >= windowMs) {
      entry = { startedAt: now, count: 0 };
      this.rateBuckets.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  cleanupRooms() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (now - room.createdAt <= ROOM_TTL_MS) continue;
      for (const peer of room.peers.values()) {
        peer.meta.roomCode = null;
        peer.meta.role = null;
        peer.meta.state = defaultPeerState();
        this.send(peer.ws, { type: 'room-closed', reason: 'expired' });
      }
      this.rooms.delete(code);
    }
    if (this.rateBuckets.size > 10_000) {
      for (const [key, entry] of this.rateBuckets) {
        if (now - entry.startedAt > 10 * 60 * 1000) this.rateBuckets.delete(key);
      }
    }
  }

  leaveRoom(meta, reason = 'left') {
    if (!meta.roomCode) return;
    const room = this.rooms.get(meta.roomCode);
    if (!room) {
      meta.roomCode = null;
      meta.role = null;
      meta.state = defaultPeerState();
      return;
    }

    const wasHost = room.hostId === meta.id;
    room.peers.delete(meta.id);
    meta.roomCode = null;
    meta.role = null;
    meta.state = defaultPeerState();

    if (wasHost) {
      for (const remaining of room.peers.values()) {
        remaining.meta.roomCode = null;
        remaining.meta.role = null;
        remaining.meta.state = defaultPeerState();
        this.send(remaining.ws, { type: 'room-closed', reason: 'host-left' });
      }
      this.rooms.delete(room.code);
      return;
    }

    if (room.peers.size === 0) {
      this.rooms.delete(room.code);
      return;
    }

    const host = room.peers.get(room.hostId);
    if (host) {
      this.send(host.ws, { type: 'peer-left', peerId: meta.id, reason });
    }
  }

  handleCreate(ws, meta, ip) {
    if (meta.roomCode) {
      return this.sendError(ws, 'ALREADY_IN_ROOM', '你已经在房间里了');
    }
    if (!this.allowRate(ip, 'create', 20, 60_000)) {
      return this.sendError(ws, 'RATE_LIMITED', '创建房间太频繁，请稍后再试');
    }
    this.cleanupRooms();
    if (this.rooms.size >= MAX_ROOMS) {
      return this.sendError(ws, 'SERVER_BUSY', '服务器房间已满，请稍后再试');
    }

    const code = randomRoomCode(this.rooms);
    const room = {
      code,
      createdAt: Date.now(),
      hostId: meta.id,
      peers: new Map(),
    };
    meta.roomCode = code;
    meta.role = 'host';
    room.peers.set(meta.id, { meta, ws });
    this.rooms.set(code, room);

    this.send(ws, {
      type: 'created',
      room: code,
      selfId: meta.id,
      role: 'host',
      peer: null,
    });
  }

  handleJoin(ws, meta, ip, rawCode) {
    if (meta.roomCode) {
      return this.sendError(ws, 'ALREADY_IN_ROOM', '你已经在房间里了');
    }
    if (!this.allowRate(ip, 'join', 120, 60_000)) {
      return this.sendError(ws, 'RATE_LIMITED', '加入操作太频繁，请稍后再试');
    }

    const code = String(rawCode || '').trim().toUpperCase();
    if (!ROOM_CODE_RE.test(code)) {
      return this.sendError(ws, 'INVALID_CODE', '房间码应为 6 位字母或数字');
    }

    this.cleanupRooms();
    const room = this.rooms.get(code);
    if (!room) {
      return this.sendError(ws, 'ROOM_NOT_FOUND', '没有找到这个房间，请核对房间码');
    }
    if (room.peers.size >= MAX_ROOM_SIZE) {
      return this.sendError(ws, 'ROOM_FULL', '房间已满，每条声音通道最多两人');
    }

    meta.roomCode = code;
    meta.role = 'guest';
    room.peers.set(meta.id, { meta, ws });
    const host = room.peers.get(room.hostId);

    this.send(ws, {
      type: 'joined',
      room: code,
      selfId: meta.id,
      role: 'guest',
      peer: host ? peerInfo(host.meta) : null,
      initiate: true,
    });

    if (host) {
      this.send(host.ws, {
        type: 'peer-joined',
        peer: peerInfo(meta),
      });
    }
  }

  handleSignal(ws, meta, data) {
    if (!meta.roomCode || !data || typeof data !== 'object') return;
    const room = this.rooms.get(meta.roomCode);
    if (!room) return;
    const peer = this.otherPeer(room, meta.id);
    if (!peer) return;

    const description = data.description;
    const candidate = data.candidate;
    const validDescription =
      description &&
      typeof description === 'object' &&
      (description.type === 'offer' ||
        description.type === 'answer' ||
        description.type === 'pranswer' ||
        description.type === 'rollback');
    const validCandidate = candidate && typeof candidate === 'object';
    const validControl = data.control === 'renegotiate';

    if (!validDescription && !validCandidate && !validControl) return;

    this.send(peer.ws, {
      type: 'signal',
      from: meta.id,
      data: {
        ...(validDescription ? { description } : {}),
        ...(validCandidate ? { candidate } : {}),
        ...(validControl ? { control: data.control } : {}),
      },
    });
  }

  handleState(ws, meta, data) {
    if (!meta.roomCode || !data || typeof data !== 'object') return;
    const room = this.rooms.get(meta.roomCode);
    if (!room) return;
    meta.state = {
      sharing: Boolean(data.sharing),
      mic: Boolean(data.mic),
      relay: Boolean(meta.state.relay),
    };
    const peer = this.otherPeer(room, meta.id);
    if (peer) {
      this.send(peer.ws, {
        type: 'peer-state',
        peerId: meta.id,
        sharing: meta.state.sharing,
        mic: meta.state.mic,
      });
    }
  }

  handleRelayState(ws, meta, data) {
    if (!meta.roomCode || !data || typeof data !== 'object') return;
    const room = this.rooms.get(meta.roomCode);
    if (!room) return;
    meta.state.relay = Boolean(data.active);
    const peer = this.otherPeer(room, meta.id);
    if (peer) {
      this.send(peer.ws, {
        type: 'peer-relay',
        active: meta.state.relay,
        relay: meta.state.relay,
      });
    }
  }

  handleBinary(ws, meta, data) {
    if (!meta.roomCode) return;
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : null;
    if (!view || view.byteLength < 10 || view.byteLength > MAX_BINARY_BYTES || view[0] !== 1) return;

    const room = this.rooms.get(meta.roomCode);
    if (!room) return;
    const peer = this.otherPeer(room, meta.id);
    if (!peer || peer.ws.readyState !== 1) return;

    try {
      const payload = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      peer.ws.send(payload);
    } catch {
      // 接收方断开，忽略这个音频包。
    }
  }

  handleMessage(ws, meta, raw) {
    if (typeof raw !== 'string') {
      this.handleBinary(ws, meta, raw);
      return;
    }
    if (raw.length > MAX_TEXT_BYTES) {
      this.sendError(ws, 'BAD_MESSAGE', '消息太大');
      return;
    }

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return this.sendError(ws, 'BAD_MESSAGE', '无法解析消息');
    }
    if (!message || typeof message.type !== 'string') {
      return this.sendError(ws, 'BAD_MESSAGE', '消息格式不正确');
    }

    switch (message.type) {
      case 'create':
        this.handleCreate(ws, meta, meta.ip);
        break;
      case 'join':
        this.handleJoin(ws, meta, meta.ip, message.room);
        break;
      case 'signal':
        this.handleSignal(ws, meta, message.data);
        break;
      case 'state':
        this.handleState(ws, meta, message);
        break;
      case 'relay-state':
        this.handleRelayState(ws, meta, message);
        break;
      case 'leave':
        this.leaveRoom(meta, 'left');
        this.send(ws, { type: 'left' });
        break;
      case 'ping':
        this.send(ws, { type: 'pong', at: Date.now() });
        break;
      default:
        this.sendError(ws, 'UNKNOWN_TYPE', '未知的消息类型');
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return jsonResponse({
        ok: true,
        rooms: this.rooms.size,
        uptime: Math.round((Date.now() - this.startedAt) / 1000),
      });
    }

    if (String(request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return jsonResponse({ error: 'UPGRADE_REQUIRED', message: '请使用 WebSocket 连接' }, 426);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const meta = {
      id: crypto.randomUUID(),
      ip: request.headers.get('cf-connecting-ip') || 'unknown',
      roomCode: null,
      role: null,
      state: defaultPeerState(),
    };

    server.addEventListener('message', (event) => {
      try {
        this.handleMessage(server, meta, event.data);
      } catch {
        this.sendError(server, 'SERVER_ERROR', '服务器处理消息时出错');
      }
    });
    server.addEventListener('close', () => {
      this.leaveRoom(meta, 'disconnected');
    });
    server.addEventListener('error', () => {
      this.leaveRoom(meta, 'error');
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
