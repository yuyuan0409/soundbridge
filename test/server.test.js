import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let port;
let baseUrl;
let serverProcess;
let serverLog = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error('服务端进程提前退出：\n' + serverLog);
    }
    try {
      const response = await fetch(url + '/healthz');
      if (response.ok) return;
    } catch {
      // Retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('服务端启动超时：\n' + serverLog);
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.waiters = [];
    this.messages = [];
    this.binaryQueue = [];
    this.binaryWaiters = [];
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const buffer = Buffer.from(raw);
        const waiter = this.binaryWaiters.shift();
        if (waiter) waiter(buffer);
        else this.binaryQueue.push(buffer);
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.messages.push(message);
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  static async connect() {
    const ws = new WebSocket(baseUrl.replace('http', 'ws') + '/ws');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 3000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new Client(ws);
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  next(type, timeout = 3000) {
    const existing = this.queue.findIndex((message) => message.type === type);
    if (existing !== -1) return Promise.resolve(this.queue.splice(existing, 1)[0]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(handler);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error('等待消息 ' + type + ' 超时，已收到：' + JSON.stringify(this.messages)));
      }, timeout);

      const handler = (message) => {
        if (message.type !== type) {
          this.queue.push(message);
          this.waiters.unshift(handler);
          return;
        }
        clearTimeout(timer);
        resolve(message);
      };
      this.waiters.push(handler);
    });
  }

  nextBinary(timeout = 3000) {
    if (this.binaryQueue.length) return Promise.resolve(this.binaryQueue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.binaryWaiters.indexOf(handler);
        if (index !== -1) this.binaryWaiters.splice(index, 1);
        reject(new Error('等待二进制中继包超时'));
      }, timeout);
      const handler = (buffer) => {
        clearTimeout(timer);
        resolve(buffer);
      };
      this.binaryWaiters.push(handler);
    });
  }

  async createRoom() {
    this.send({ type: 'create' });
    const message = await this.next('created');
    return message;
  }

  async join(code) {
    this.send({ type: 'join', room: code });
    return this.next('joined');
  }

  close() {
    this.ws.close();
  }
}

before(async () => {
  port = await freePort();
  baseUrl = 'http://127.0.0.1:' + port;
  serverProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      HTTPS: '0',
      PUBLIC_URL: 'https://sound.example.com',
      TURN_URLS: 'turn:turn.example.com:3478?transport=udp',
      TURN_SECRET: 'unit-test-secret',
      TURN_TTL: '600',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  serverProcess.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  await waitForServer(baseUrl);
});

after(async () => {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => serverProcess.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]);
  if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL');
});

test('静态资源、安全头与运行时配置', async () => {
  const page = await fetch(baseUrl + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const html = await page.text();
  assert.match(html, /声桥/);
  assert.match(html, /app\.js/);

  const favicon = await fetch(baseUrl + '/favicon.ico');
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get('content-type'), /image\/svg/);

  const missing = await fetch(baseUrl + '/no-such-page');
  assert.equal(missing.status, 404);

  const configResponse = await fetch(baseUrl + '/api/config');
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.publicUrl, 'https://sound.example.com');
  assert.equal(config.turnEnabled, true);
  assert.equal(config.relayEnabled, true);
  assert.equal(config.iceServers.length, 2);
  assert.ok(config.iceServers.some((entry) => String(entry.urls).includes('stun:')));
  const turn = config.iceServers.find((entry) => String(entry.urls).includes('turn:'));
  assert.ok(turn);
  assert.match(turn.username, /^\d+:sb[0-9a-f]{8}$/);
  assert.ok(turn.credential.length > 10);
  assert.equal(JSON.stringify(config).includes('unit-test-secret'), false);
  assert.ok(Array.isArray(config.lanUrls));

  const wsResponse = await fetch(baseUrl + '/ws');
  assert.equal(wsResponse.status, 426);
});

test('创建、加入、信令中继与房主关闭房间', async () => {
  const host = await Client.connect();
  const created = await host.createRoom();
  assert.match(created.room, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(created.role, 'host');
  assert.equal(created.peer, null);

  const guest = await Client.connect();
  const joined = await guest.join(created.room);
  assert.equal(joined.role, 'guest');
  assert.equal(joined.initiate, true);
  assert.equal(joined.peer.id, created.selfId);

  const peerJoined = await host.next('peer-joined');
  assert.equal(peerJoined.peer.id, joined.selfId);

  guest.send({ type: 'signal', data: { description: { type: 'offer', sdp: 'v=0' } } });
  const offer = await host.next('signal');
  assert.equal(offer.from, joined.selfId);
  assert.equal(offer.data.description.sdp, 'v=0');

  guest.send({ type: 'signal', data: { control: 'renegotiate' } });
  const control = await host.next('signal');
  assert.equal(control.data.control, 'renegotiate');

  guest.send({ type: 'state', sharing: true, mic: true });
  const state = await host.next('peer-state');
  assert.equal(state.sharing, true);
  assert.equal(state.mic, true);

  const third = await Client.connect();
  third.send({ type: 'join', room: created.room });
  const full = await third.next('error');
  assert.equal(full.code, 'ROOM_FULL');
  third.close();

  guest.close();
  const left = await host.next('peer-left');
  assert.equal(left.peerId, joined.selfId);

  const guestAgain = await Client.connect();
  const joinedAgain = await guestAgain.join(created.room);
  assert.equal(joinedAgain.role, 'guest');
  await host.next('peer-joined');

  host.close();
  const closed = await guestAgain.next('room-closed');
  assert.equal(closed.reason, 'host-left');
  guestAgain.close();
});

test('错误房间码与不存在的房间', async () => {
  const client = await Client.connect();
  client.send({ type: 'join', room: 'ABC' });
  const invalid = await client.next('error');
  assert.equal(invalid.code, 'INVALID_CODE');

  client.send({ type: 'join', room: 'ZZZZZZ' });
  const missing = await client.next('error');
  assert.equal(missing.code, 'ROOM_NOT_FOUND');
  client.close();
});

test('服务器中继状态与二进制音频包转发', async () => {
  const host = await Client.connect();
  const created = await host.createRoom();
  const guest = await Client.connect();
  await guest.join(created.room);
  await host.next('peer-joined');

  host.send({ type: 'relay-state', active: true });
  const relayState = await guest.next('peer-relay');
  assert.equal(relayState.active, true);

  const packet = Buffer.concat([Buffer.from([1]), Buffer.alloc(8), Buffer.from('opus-frame')]);
  guest.ws.send(packet);
  const received = await host.nextBinary();
  assert.deepEqual(received, packet);

  guest.close();
  host.close();
});

test('访客离开后房主可以等待新的访客', async () => {
  const host = await Client.connect();
  const created = await host.createRoom();
  const guest = await Client.connect();
  await guest.join(created.room);
  await host.next('peer-joined');

  guest.send({ type: 'leave' });
  await guest.next('left');
  const left = await host.next('peer-left');
  assert.equal(left.reason, 'left');

  const nextGuest = await Client.connect();
  const joined = await nextGuest.join(created.room);
  assert.equal(joined.role, 'guest');
  await host.next('peer-joined');

  nextGuest.close();
  host.close();
});
