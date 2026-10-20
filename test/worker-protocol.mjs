import WebSocket from 'ws';

// 需要先运行 `npm run worker:dev`，或设置 WORKER_URL 指向已部署的 Worker。
const base = process.env.WORKER_URL || 'http://127.0.0.1:8788';
const url = base.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  const events = [];
  ws.on('message', (data, isBinary) => {
    events.push({ data: isBinary ? Buffer.from(data) : String(data), binary: isBinary });
    const index = waiters.findIndex((w) => w.match(events[events.length - 1]));
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(events.pop());
    }
  });
  return { ws, events, waiters };
}

function waitFor(c, type, timeout = 5000) {
  const match = (event) => {
    if (event.binary) return type === 'binary';
    try {
      return JSON.parse(event.data).type === type;
    } catch {
      return false;
    }
  };
  const existing = c.events.findIndex(match);
  if (existing >= 0) return Promise.resolve(c.events.splice(existing, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = {
      match,
      resolve,
      timer: setTimeout(() => {
        const index = c.waiters.indexOf(waiter);
        if (index >= 0) c.waiters.splice(index, 1);
        reject(new Error('timeout waiting for ' + type));
      }, timeout),
    };
    c.waiters.push(waiter);
  });
}

function send(c, payload) {
  c.ws.send(JSON.stringify(payload));
}

const a = client();
await new Promise((resolve, reject) => {
  a.ws.once('open', resolve);
  a.ws.once('error', reject);
});
send(a, { type: 'create' });
const created = JSON.parse((await waitFor(a, 'created')).data);
console.log('created', created.room, created.role);

const b = client();
await new Promise((resolve, reject) => {
  b.ws.once('open', resolve);
  b.ws.once('error', reject);
});
send(b, { type: 'join', room: created.room });
const joined = JSON.parse((await waitFor(b, 'joined')).data);
const joinedA = JSON.parse((await waitFor(a, 'peer-joined')).data);
console.log('joined', joined.role, joined.peer && joined.peer.id === created.selfId, Boolean(joinedA.peer));

send(a, { type: 'state', sharing: true, mic: false });
const state = JSON.parse((await waitFor(b, 'peer-state')).data);
console.log('state', state.sharing, state.mic);

send(b, { type: 'relay-state', active: true });
const relay = JSON.parse((await waitFor(a, 'peer-relay')).data);
console.log('relay', relay.active);

const packet = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 42]);
send(a, { type: 'signal', data: { control: 'renegotiate' } });
const signal = JSON.parse((await waitFor(b, 'signal')).data);
console.log('signal', signal.data.control);

a.ws.send(packet);
const binary = await waitFor(b, 'binary');
console.log('binary', binary.data.length, binary.data[0], binary.data[9]);

send(b, { type: 'leave' });
const left = JSON.parse((await waitFor(a, 'peer-left')).data);
console.log('peer-left', left.reason);

a.ws.close();
b.ws.close();
await sleep(100);
console.log('worker websocket check passed');
