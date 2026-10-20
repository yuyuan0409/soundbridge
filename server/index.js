#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.warn('[env] 读取 .env 失败：', error.message);
  }
}

const PORT = Number(process.env.PORT || 8787);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ROOM_SIZE = 2;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function detectPrimaryAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let finished = false;
    const finish = (address) => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch {
        // Ignore.
      }
      resolve(address);
    };
    socket.on('error', () => finish(null));
    socket.connect(53, '1.1.1.1', () => {
      try {
        finish(socket.address().address);
      } catch {
        finish(null);
      }
    });
    setTimeout(() => finish(null), 1200).unref();
  });
}

const primaryAddress = await detectPrimaryAddress();

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.apk', 'application/vnd.android.package-archive'],
  ['.zip', 'application/zip'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

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

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

const httpsDisabled = process.env.HTTPS === '0' || process.env.HTTPS === 'false';
const certPath = process.env.TLS_CERT
  ? path.resolve(ROOT, process.env.TLS_CERT)
  : path.join(ROOT, 'certs', 'cert.pem');
const keyPath = process.env.TLS_KEY
  ? path.resolve(ROOT, process.env.TLS_KEY)
  : path.join(ROOT, 'certs', 'key.pem');

let tls = null;
if (!httpsDisabled && existsSync(certPath) && existsSync(keyPath)) {
  try {
    tls = { cert: await readFile(certPath), key: await readFile(keyPath) };
  } catch (error) {
    console.error('[tls] 证书读取失败：', error.message);
    process.exit(1);
  }
} else if (process.env.TLS_CERT || process.env.TLS_KEY) {
  console.error('[tls] 已指定 TLS_CERT / TLS_KEY，但证书文件不存在。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ICE / TURN
// ---------------------------------------------------------------------------

const splitUrls = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const stunUrls = splitUrls(process.env.STUN_URLS || 'stun:stun.l.google.com:19302');
const turnUrls = splitUrls(process.env.TURN_URLS);
const turnSecret = process.env.TURN_SECRET || '';
const turnUsername = process.env.TURN_USERNAME || '';
const turnCredential = process.env.TURN_CREDENTIAL || '';
const turnTtl = Math.min(Math.max(Number(process.env.TURN_TTL) || 3600, 300), 86400);

function iceServersForClient() {
  const servers = [];
  if (stunUrls.length) servers.push({ urls: stunUrls });

  if (turnUrls.length && turnSecret) {
    const username =
      String(Math.floor(Date.now() / 1000) + turnTtl) +
      ':sb' +
      crypto.randomBytes(4).toString('hex');
    const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
    servers.push({ urls: turnUrls, username, credential });
  } else if (turnUrls.length && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return servers;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

const rooms = new Map();
const rateBuckets = new Map();

function randomRoomCode() {
  for (;;) {
    let code = '';
    for (let index = 0; index < 6; index += 1) {
      code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return request.socket.remoteAddress || 'unknown';
}

function allowRate(ip, bucket, limit, windowMs) {
  const key = ip + ':' + bucket;
  const now = Date.now();
  let entry = rateBuckets.get(key);
  if (!entry || now - entry.startedAt >= windowMs) {
    entry = { startedAt: now, count: 0 };
    rateBuckets.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= limit;
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

function otherPeer(room, peerId) {
  for (const peer of room.peers.values()) {
    if (peer.id !== peerId) return peer;
  }
  return null;
}

function defaultPeerState() {
  return { sharing: false, mic: false, relay: false };
}

function leaveRoom(peer, reason = 'left') {
  if (!peer.roomCode) return;
  const room = rooms.get(peer.roomCode);
  if (!room) {
    peer.roomCode = null;
    peer.role = null;
    peer.state = defaultPeerState();
    return;
  }

  const wasHost = room.hostId === peer.id;
  room.peers.delete(peer.id);
  peer.roomCode = null;
  peer.role = null;
  peer.state = defaultPeerState();

  if (wasHost) {
    for (const remaining of room.peers.values()) {
      const remainingId = remaining.id;
      remaining.roomCode = null;
      remaining.role = null;
      remaining.state = defaultPeerState();
      send(remaining.ws, { type: 'room-closed', reason: 'host-left' });
      console.log(
        '[room ' + room.code + '] 关闭，房主 ' + peer.id.slice(0, 6) + ' 离开，移除 ' + remainingId.slice(0, 6),
      );
    }
    rooms.delete(room.code);
    return;
  }

  if (room.peers.size === 0) {
    rooms.delete(room.code);
    return;
  }

  const host = room.peers.get(room.hostId);
  if (host) {
    send(host.ws, {
      type: 'peer-left',
      peerId: peer.id,
      reason,
    });
  }
}

function handleCreate(ws, ip) {
  if (ws.meta.roomCode) {
    return sendError(ws, 'ALREADY_IN_ROOM', '你已经在房间里了');
  }
  if (!allowRate(ip, 'create', 20, 60_000)) {
    return sendError(ws, 'RATE_LIMITED', '创建房间太频繁，请稍后再试');
  }

  const code = randomRoomCode();
  const room = {
    code,
    createdAt: Date.now(),
    hostId: ws.meta.id,
    peers: new Map(),
  };
  ws.meta.roomCode = code;
  ws.meta.role = 'host';
  room.peers.set(ws.meta.id, ws.meta);
  rooms.set(code, room);

  send(ws, {
    type: 'created',
    room: code,
    selfId: ws.meta.id,
    role: 'host',
    peer: null,
  });
  console.log('[room ' + code + '] 由 ' + ip + ' 创建');
}

function handleJoin(ws, ip, rawCode) {
  if (ws.meta.roomCode) {
    return sendError(ws, 'ALREADY_IN_ROOM', '你已经在房间里了');
  }
  if (!allowRate(ip, 'join', 120, 60_000)) {
    return sendError(ws, 'RATE_LIMITED', '加入操作太频繁，请稍后再试');
  }

  const code = String(rawCode || '').trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    return sendError(ws, 'INVALID_CODE', '房间码应为 6 位字母或数字');
  }

  const room = rooms.get(code);
  if (!room) {
    return sendError(ws, 'ROOM_NOT_FOUND', '没有找到这个房间，请核对房间码');
  }
  if (room.peers.size >= MAX_ROOM_SIZE) {
    return sendError(ws, 'ROOM_FULL', '房间已满，每条声音通道最多两人');
  }

  ws.meta.roomCode = code;
  ws.meta.role = 'guest';
  room.peers.set(ws.meta.id, ws.meta);
  const host = room.peers.get(room.hostId);

  send(ws, {
    type: 'joined',
    room: code,
    selfId: ws.meta.id,
    role: 'guest',
    peer: host
      ? {
          id: host.id,
          sharing: host.state.sharing,
          mic: host.state.mic,
          relay: host.state.relay,
        }
      : null,
    initiate: true,
  });

  if (host) {
    send(host.ws, {
      type: 'peer-joined',
      peer: {
        id: ws.meta.id,
        sharing: ws.meta.state.sharing,
        mic: ws.meta.state.mic,
        relay: ws.meta.state.relay,
      },
    });
  }
  console.log('[room ' + code + '] ' + ip + ' 加入');
}

function handleSignal(ws, data) {
  if (!ws.meta.roomCode || !data || typeof data !== 'object') return;
  const room = rooms.get(ws.meta.roomCode);
  if (!room) return;
  const peer = otherPeer(room, ws.meta.id);
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

  send(peer.ws, {
    type: 'signal',
    from: ws.meta.id,
    data: {
      ...(validDescription ? { description } : {}),
      ...(validCandidate ? { candidate } : {}),
      ...(validControl ? { control: data.control } : {}),
    },
  });
}

function handleState(ws, data) {
  if (!ws.meta.roomCode || !data || typeof data !== 'object') return;
  const room = rooms.get(ws.meta.roomCode);
  if (!room) return;
  ws.meta.state = {
    sharing: Boolean(data.sharing),
    mic: Boolean(data.mic),
    relay: Boolean(ws.meta.state.relay),
  };
  const peer = otherPeer(room, ws.meta.id);
  if (peer) {
    send(peer.ws, {
      type: 'peer-state',
      peerId: ws.meta.id,
      sharing: ws.meta.state.sharing,
      mic: ws.meta.state.mic,
    });
  }
}

function handleRelayState(ws, data) {
  if (!ws.meta.roomCode || !data || typeof data !== 'object') return;
  const room = rooms.get(ws.meta.roomCode);
  if (!room) return;

  ws.meta.state.relay = Boolean(data.active);
  const peer = otherPeer(room, ws.meta.id);
  if (peer) {
    send(peer.ws, {
      type: 'peer-relay',
      active: ws.meta.state.relay,
      relay: ws.meta.state.relay,
    });
  }
}

function relayBinary(ws, raw) {
  if (!ws.meta.roomCode) return;
  if (!Buffer.isBuffer(raw) || raw.length < 10 || raw.length > 16_384) return;
  if (raw[0] !== 1) return;

  const room = rooms.get(ws.meta.roomCode);
  if (!room) return;
  const peer = otherPeer(room, ws.meta.id);
  if (!peer || peer.ws.readyState !== WebSocket.OPEN) return;

  peer.ws.send(raw, { binary: true });
}

function handleMessage(ws, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return sendError(ws, 'BAD_MESSAGE', '无法解析消息');
  }
  if (!message || typeof message.type !== 'string') {
    return sendError(ws, 'BAD_MESSAGE', '消息格式不正确');
  }

  const ip = ws.meta.ip;
  switch (message.type) {
    case 'create':
      handleCreate(ws, ip);
      break;
    case 'join':
      handleJoin(ws, ip, message.room);
      break;
    case 'signal':
      handleSignal(ws, message.data);
      break;
    case 'state':
      handleState(ws, message);
      break;
    case 'relay-state':
      handleRelayState(ws, message);
      break;
    case 'leave':
      leaveRoom(ws.meta, 'left');
      send(ws, { type: 'left' });
      break;
    case 'ping':
      send(ws, { type: 'pong', at: Date.now() });
      break;
    default:
      sendError(ws, 'UNKNOWN_TYPE', '未知的消息类型');
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function setHeaders(res, extra = {}) {
  for (const [key, value] of Object.entries({ ...SECURITY_HEADERS, ...extra })) {
    res.setHeader(key, value);
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  setHeaders(res, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.writeHead(status);
  res.end(body);
}

function networkAddresses() {
  const result = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (address.address.startsWith('169.254.')) continue;
      result.push({ name, address: address.address });
    }
  }
  result.sort((left, right) => {
    if (left.address === primaryAddress) return -1;
    if (right.address === primaryAddress) return 1;
    return left.address.localeCompare(right.address);
  });
  return result;
}

function originFor(address, scheme, port) {
  const defaultPort = scheme === 'https' ? 443 : 80;
  const suffix = Number(port) === defaultPort ? '' : ':' + port;
  return scheme + '://' + address + suffix;
}

function publicConfig() {
  const iceServers = iceServersForClient();
  const turnEnabled = iceServers.some((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) =>
      String(url).startsWith('turn'),
    ),
  );
  const useHttps = Boolean(tls && httpsListening);
  return {
    iceServers,
    secure: useHttps,
    turnEnabled,
    relayEnabled: true,
    publicUrl: process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/+$/, '') : '',
    httpsPort: useHttps ? HTTPS_PORT : null,
    lanUrls: networkAddresses().map(({ name, address }) => ({
      name,
      url: originFor(address, useHttps ? 'https' : 'http', useHttps ? HTTPS_PORT : PORT),
    })),
    version: '1.0.0',
  };
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'BAD_PATH', message: '路径格式不正确' });
  }

  if (decoded.includes('\0')) {
    return sendJson(res, 400, { error: 'BAD_PATH', message: '路径格式不正确' });
  }
  if (decoded === '/') decoded = '/index.html';
  if (decoded.endsWith('/')) decoded += 'index.html';

  const filePath = path.resolve(PUBLIC_DIR, '.' + decoded);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'FORBIDDEN', message: '禁止访问' });
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return sendJson(res, 404, { error: 'NOT_FOUND', message: '页面不存在' });
  }
  if (!info.isFile()) {
    return sendJson(res, 404, { error: 'NOT_FOUND', message: '页面不存在' });
  }

  const extension = path.extname(filePath).toLowerCase();
  const cacheControl = decoded === '/index.html' ? 'no-store' : 'no-cache';
  setHeaders(res, {
    'Content-Type': MIME_TYPES.get(extension) || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': cacheControl,
    'Last-Modified': info.mtime.toUTCString(),
  });
  if (req.socket.encrypted) {
    res.setHeader('Strict-Transport-Security', 'max-age=86400');
  }

  if (req.method === 'HEAD') {
    res.writeHead(200);
    return res.end();
  }
  res.writeHead(200);
  createReadStream(filePath).pipe(res);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(
      res,
      405,
      { error: 'METHOD_NOT_ALLOWED', message: '只支持 GET 请求' },
      { Allow: 'GET, HEAD' },
    );
  }

  if (url.pathname === '/healthz') {
    return sendJson(res, 200, {
      ok: true,
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
      secure: Boolean(tls),
    });
  }

  if (url.pathname === '/api/config') {
    return sendJson(res, 200, publicConfig());
  }

  if (url.pathname === '/favicon.ico') {
    return serveStatic(req, res, '/icon.svg');
  }

  if (url.pathname === '/ws') {
    return sendJson(res, 426, { error: 'UPGRADE_REQUIRED', message: '请使用 WebSocket 连接' });
  }

  return serveStatic(req, res, url.pathname);
}

// ---------------------------------------------------------------------------
// Server + WebSocket
// ---------------------------------------------------------------------------

const requestHandler = (req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('[http]', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'SERVER_ERROR', message: '服务器开小差了' });
    else res.destroy();
  });
};

const httpServer = http.createServer(requestHandler);
const httpsServer = tls ? https.createServer(tls, requestHandler) : null;
const servers = httpsServer ? [httpServer, httpsServer] : [httpServer];
let httpsListening = false;
let startupSettled = 0;
let startupFailed = false;

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

function handleUpgrade(req, socket, head) {
  let pathname = '';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}

function settleStartup() {
  startupSettled += 1;
  if (startupSettled === servers.length) printStartup();
}

for (const item of servers) {
  item.on('upgrade', handleUpgrade);
  item.on('listening', () => {
    if (item === httpsServer) httpsListening = true;
    settleStartup();
  });
  item.on('error', (error) => {
    startupFailed = true;
    console.error('[server]', error.message);
    settleStartup();
  });
}

wss.on('connection', (ws, req) => {
  if (rooms.size > 5000) {
    send(ws, { type: 'error', code: 'SERVER_BUSY', message: '服务器房间已满，请稍后再试' });
    ws.close(1013, 'busy');
    return;
  }

  ws.isAlive = true;
  ws.meta = {
    id: crypto.randomUUID(),
    ip: clientIp(req),
    roomCode: null,
    role: null,
    state: defaultPeerState(),
    ws,
  };

  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (raw, isBinary) => {
    try {
      if (isBinary) relayBinary(ws, raw);
      else handleMessage(ws, raw);
    } catch (error) {
      console.error('[ws]', error);
      sendError(ws, 'SERVER_ERROR', '服务器处理消息时出错');
    }
  });
  ws.on('close', () => {
    leaveRoom(ws.meta, 'disconnected');
  });
  ws.on('error', (error) => {
    console.warn('[ws] error:', error.message);
  });

  send(ws, {
    type: 'hello',
    selfId: ws.meta.id,
    serverTime: Date.now(),
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // Ignore sockets that disappeared between iterations.
    }
  }
}, 30_000);
heartbeat.unref();

const roomCleanup = setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const room of rooms.values()) {
    if (room.createdAt > cutoff) continue;
    for (const peer of room.peers.values()) {
      peer.roomCode = null;
      peer.role = null;
      send(peer.ws, { type: 'room-closed', reason: 'expired' });
    }
    rooms.delete(room.code);
  }

  const rateCutoff = Date.now() - 10 * 60_000;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.startedAt < rateCutoff) rateBuckets.delete(key);
  }
}, 60_000);
roomCleanup.unref();

function printStartup() {
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │  声桥 SoundBridge · 双向声音共享             │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log('  本机访问   ' + originFor('localhost', 'http', PORT));

  const lanAddresses = networkAddresses();

  if (httpsListening) {
    console.log('  本机 HTTPS ' + originFor('localhost', 'https', HTTPS_PORT) + '  (系统声音采集)');
    for (const { name, address } of lanAddresses) {
      console.log('  局域网     ' + originFor(address, 'https', HTTPS_PORT) + '  (' + name + ')');
    }
    if (lanAddresses.length) {
      console.log(
        '  首选地址   ' +
          originFor(lanAddresses[0].address, 'https', HTTPS_PORT) +
          '  ← 发给对方用这个',
      );
    }
  } else {
    for (const { name, address } of lanAddresses) {
      console.log('  局域网     ' + originFor(address, 'http', PORT) + '  (' + name + ')');
    }
  }

  if (process.env.PUBLIC_URL) console.log('  公网地址   ' + process.env.PUBLIC_URL);
  console.log('  协议       ' + (httpsListening ? 'HTTP + HTTPS（双端口）' : 'HTTP'));

  if (httpsListening) {
    console.log('  提示       自签名证书首次打开需要点击“高级 → 继续前往”');
    console.log(
      '  提示       ' +
        (process.env.PUBLIC_URL
          ? '邀请链接将使用 PUBLIC_URL 公网地址'
          : '“复制邀请链接”会优先使用 HTTPS 局域网地址'),
    );
  } else {
    console.log('  提示       通过非 localhost 地址访问时，浏览器需要 HTTPS 才允许采集声音');
  }
  if (startupFailed) {
    console.log('  警告       至少有一个端口启动失败，请检查上方错误信息');
  }
  console.log('  中继       已启用（WSS + Opus 自动兜底）');
  if (!turnUrls.length) {
    console.log('  提示       未配置 TURN；直连失败时会自动切换到服务器中继');
  } else if (!turnSecret && !(turnUsername && turnCredential)) {
    console.log('  提示       TURN_URLS 已配置，但缺少凭据（TURN_SECRET 或用户名密码）');
  } else {
    console.log('  提示       TURN 已配置，用于跨网络直连');
  }
  console.log('');
}

httpServer.listen(PORT, HOST);
if (httpsServer) httpsServer.listen(HTTPS_PORT, HOST);

function shutdown(signal) {
  console.log('\n收到 ' + signal + '，正在关闭…');
  clearInterval(heartbeat);
  clearInterval(roomCleanup);
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'server shutting down');
    } catch {
      // Ignore.
    }
  }
  wss.close();
  const openServers = servers.filter((item) => item.listening);
  let closed = 0;
  const maybeExit = () => {
    closed += 1;
    if (closed >= openServers.length) process.exit(0);
  };
  for (const item of openServers) item.close(maybeExit);
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));