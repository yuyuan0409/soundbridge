import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
mkdirSync(ARTIFACTS, { recursive: true });

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chromePath) {
  throw new Error('没有找到 Chrome / Edge。请设置 CHROME_PATH 环境变量后重试。');
}

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

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url + '/healthz');
      if (response.ok) return;
    } catch {
      // Retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('测试用服务端启动超时');
}

async function waitForRemoteBytes(page, minimum = 1000) {
  let last = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = await page.evaluate(() => window.SoundBridge.getStats());
    if (last && last.bytesReceived >= minimum && last.packetsReceived > 10) return last;
    await page.waitForTimeout(250);
  }
  throw new Error('没有等到远端音频包：' + JSON.stringify(last));
}

const installFakeMedia = () => {
  const contexts = [];
  const makeAudio = (frequency) => {
    const context = new AudioContext();
    contexts.push(context);
    if (context.state === 'suspended') context.resume().catch(() => {});
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const gain = context.createGain();
    gain.gain.value = 0.12;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    return destination.stream.getAudioTracks()[0];
  };

  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext('2d');
      if (context) {
        context.fillStyle = '#0a1018';
        context.fillRect(0, 0, 32, 32);
      }
      const video = canvas.captureStream(2).getVideoTracks()[0];
      const audio = makeAudio(440);
      window.__fakeMedia = { contexts };
      return new MediaStream([video, audio]);
    },
  });

  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async () => {
      const audio = makeAudio(220);
      window.__fakeMedia = { contexts };
      return new MediaStream([audio]);
    },
  });
};

const externalBaseUrl = process.env.E2E_BASE_URL || '';
const port = externalBaseUrl ? null : await freePort();
const baseUrl = externalBaseUrl || 'http://127.0.0.1:' + port;
let serverLog = '';
let server = null;
if (!externalBaseUrl) {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      HTTPS: '0',
      PUBLIC_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
}

let browser;
const errors = [];

try {
  await waitForHealth(baseUrl);

  browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });

  const contextA = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const contextB = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await contextA.addInitScript(installFakeMedia);
  await contextB.addInitScript(installFakeMedia);

  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const wireErrors = (page, label) => {
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(label + ' console: ' + message.text());
    });
    page.on('pageerror', (error) => errors.push(label + ' pageerror: ' + error.message));
  };
  wireErrors(pageA, 'A');
  wireErrors(pageB, 'B');

  await pageA.goto(baseUrl, { waitUntil: 'networkidle' });
  await pageA.waitForFunction(() => Boolean(window.SoundBridge));
  assert.match(await pageA.title(), /声桥/);
  assert.equal(await pageA.locator('#createBtn').isVisible(), true);
  await pageA.screenshot({ path: path.join(ARTIFACTS, 'e2e-landing.png'), fullPage: true });

  await pageA.click('#createBtn');
  await pageA.waitForSelector('#roomView:not([hidden])');
  await pageA.waitForFunction(() => window.SoundBridge.getState().room);
  const roomCode = (await pageA.textContent('#roomCode')).trim();
  assert.match(roomCode, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(await pageA.locator('#inviteStrip').isVisible(), true);
  assert.match(await pageA.evaluate(() => window.SoundBridge.getInviteUrl()), /room=/);
  await pageA.waitForTimeout(3400);
  await pageA.screenshot({ path: path.join(ARTIFACTS, 'e2e-room-waiting.png'), fullPage: true });

  await pageB.goto(baseUrl + '/?room=' + roomCode, { waitUntil: 'networkidle' });
  await pageB.waitForSelector('#roomView:not([hidden])');
  await pageA.waitForFunction(() => window.SoundBridge.getState().connectionKind === 'connected', null, { timeout: 15_000 });
  await pageB.waitForFunction(() => window.SoundBridge.getState().connectionKind === 'connected', null, { timeout: 15_000 });

  const initialA = await pageA.evaluate(() => window.SoundBridge.getState());
  const initialB = await pageB.evaluate(() => window.SoundBridge.getState());
  assert.equal(initialA.pcState, 'connected');
  assert.equal(initialA.role, 'host');
  assert.equal(initialB.role, 'guest');
  assert.equal(initialA.hasRemoteStream, true);
  assert.equal(initialB.hasRemoteStream, true);
  assert.equal((await pageA.textContent('#peerPresence')).trim(), '对方已连接');
  assert.equal((await pageA.textContent('#remoteBadge')).trim(), '正在收听');
  assert.equal(
    await pageA.evaluate(() => document.getElementById('connectionAlert').classList.contains('show')),
    true,
  );
  assert.match(await pageA.textContent('#connectionAlertTitle'), /对方已连接/);
  assert.match(await pageA.textContent('#eventLog'), /对方已连接/);

  await pageA.click('#shareBtn');
  await pageA.waitForFunction(() => window.SoundBridge.getState().sharing, null, { timeout: 10_000 });
  await pageB.waitForFunction(() => window.SoundBridge.getState().peerSharing, null, { timeout: 10_000 });
  const statsBeforeMic = await waitForRemoteBytes(pageB);
  assert.ok(statsBeforeMic.bytesReceived > 1000);

  await pageA.click('#micBtn');
  await pageA.waitForFunction(() => window.SoundBridge.getState().micActive, null, { timeout: 10_000 });
  await pageB.waitForFunction(() => window.SoundBridge.getState().peerMic, null, { timeout: 10_000 });
  assert.match(await pageA.textContent('#selfState'), /麦克风/);

  await pageB.click('#shareBtn');
  await pageB.waitForFunction(() => window.SoundBridge.getState().sharing, null, { timeout: 10_000 });
  await pageA.waitForFunction(() => window.SoundBridge.getState().peerSharing, null, { timeout: 10_000 });
  assert.equal((await pageA.textContent('#remoteBadge')).trim(), '正在共享');
  await waitForRemoteBytes(pageA);

  const bothSharingA = await pageA.evaluate(() => window.SoundBridge.getState());
  const bothSharingB = await pageB.evaluate(() => window.SoundBridge.getState());
  assert.equal(bothSharingA.sharing, true);
  assert.equal(bothSharingB.sharing, true);
  assert.equal(bothSharingA.peerSharing, true);
  assert.equal(bothSharingB.peerSharing, true);

  assert.equal(await pageB.evaluate(() => document.getElementById('remoteAudio').paused), false);
  const initialVolume = await pageB.evaluate(() => document.getElementById('remoteAudio').volume);
  assert.ok(Math.abs(initialVolume - 0.8) < 0.02, '默认远端音量应为 80%');

  await pageB.click('#muteBtn');
  assert.equal(await pageB.getAttribute('#muteBtn', 'aria-pressed'), 'true');
  assert.equal(await pageB.evaluate(() => document.getElementById('remoteAudio').volume), 0);
  await pageB.click('#muteBtn');
  assert.equal(await pageB.getAttribute('#muteBtn', 'aria-pressed'), 'false');
  assert.ok((await pageB.evaluate(() => document.getElementById('remoteAudio').volume)) > 0.7);

  await pageA.click('#helpBtn');
  assert.equal(await pageA.evaluate(() => document.getElementById('helpDialog').open), true);
  await pageA.click('#helpDoneBtn');
  assert.equal(await pageA.evaluate(() => document.getElementById('helpDialog').open), false);

  await pageA.waitForTimeout(3400);
  await pageA.screenshot({ path: path.join(ARTIFACTS, 'e2e-room-both.png'), fullPage: true });

  await pageA.setViewportSize({ width: 390, height: 844 });
  await pageA.waitForTimeout(400);
  const overflow = await pageA.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, '移动端不应出现横向滚动，实际溢出：' + overflow);
  await pageA.screenshot({ path: path.join(ARTIFACTS, 'e2e-room-mobile.png'), fullPage: true });
  await pageA.setViewportSize({ width: 1440, height: 1000 });

  await pageB.click('#shareBtn');
  await pageB.waitForFunction(() => !window.SoundBridge.getState().sharing, null, { timeout: 10_000 });
  await pageA.waitForFunction(() => !window.SoundBridge.getState().peerSharing, null, { timeout: 10_000 });
  assert.equal(await pageA.locator('#remoteEmpty').isVisible(), true);

  await pageB.click('#leaveBtn');
  await pageB.waitForSelector('#landingView:not([hidden])');
  await pageA.waitForFunction(() => window.SoundBridge.getState().connectionKind === 'waiting', null, { timeout: 10_000 });
  assert.match(await pageA.textContent('#peerPresence'), /已断开/);
  assert.equal(
    await pageA.evaluate(() => document.getElementById('connectionAlert').classList.contains('show')),
    true,
  );
  assert.match(await pageA.textContent('#connectionAlertTitle'), /对方已断开/);
  assert.equal(await pageA.locator('#inviteStrip').isVisible(), true);

  await pageA.click('#leaveBtn');
  await pageA.waitForSelector('#landingView:not([hidden])');
  await pageA.setViewportSize({ width: 390, height: 844 });
  await pageA.waitForTimeout(350);
  const landingOverflow = await pageA.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(landingOverflow <= 1, '移动端首页不应出现横向滚动，实际溢出：' + landingOverflow);
  await pageA.screenshot({ path: path.join(ARTIFACTS, 'e2e-landing-mobile.png'), fullPage: true });

  await pageA.setViewportSize({ width: 1440, height: 1000 });

  // 强制中继场景：验证跨网络兜底通道（WSS + Opus）也能真实传输声音。
  await pageA.goto(baseUrl + '/?relay=1', { waitUntil: 'networkidle' });
  await pageA.waitForFunction(() => Boolean(window.SoundBridge));
  await pageA.click('#createBtn');
  await pageA.waitForFunction(() => window.SoundBridge.getState().room);
  const relayRoom = (await pageA.textContent('#roomCode')).trim();

  await pageB.goto(baseUrl + '/?relay=1&room=' + relayRoom, { waitUntil: 'networkidle' });
  await pageB.waitForSelector('#roomView:not([hidden])');
  await pageA.waitForFunction(() => window.SoundBridge.getState().relayActive, null, { timeout: 15_000 });
  await pageB.waitForFunction(() => window.SoundBridge.getState().relayActive, null, { timeout: 15_000 });
  await pageA.waitForFunction(
    () => window.SoundBridge.getState().connectionKind === 'connected',
    null,
    { timeout: 15_000 },
  );

  await pageA.click('#shareBtn');
  await pageA.waitForFunction(() => window.SoundBridge.getState().sharing, null, { timeout: 10_000 });
  await pageB.waitForFunction(() => window.SoundBridge.getState().peerSharing, null, { timeout: 10_000 });
  await pageB.waitForFunction(
    () => {
      const stats = window.SoundBridge.getState().relayStats;
      return Boolean(stats && stats.decodedFrames > 30_000);
    },
    null,
    { timeout: 15_000 },
  );

  await pageA.waitForFunction(
    () => {
      const stats = window.SoundBridge.getState().relayStats;
      return Boolean(stats && stats.sentChunks > 80);
    },
    null,
    { timeout: 15_000 },
  );
  const relaySender = await pageA.evaluate(() => window.SoundBridge.getState());
  const relayReceiver = await pageB.evaluate(() => window.SoundBridge.getState());
  assert.equal(relaySender.relaySending, true);
  assert.ok(relaySender.relayStats.sentChunks > 80);
  assert.ok(relayReceiver.relayStats.decodedFrames > 50_000);
  assert.equal(await pageB.evaluate(() => document.getElementById('remoteAudio').paused), false);
  await pageA.waitForTimeout(700);
  assert.equal((await pageA.textContent('#remoteBadge')).trim(), '正在收听');
  await pageA.screenshot({ path: path.join(ARTIFACTS, 'e2e-relay.png'), fullPage: true });

  await pageA.click('#shareBtn');
  await pageB.waitForFunction(() => !window.SoundBridge.getState().peerSharing, null, { timeout: 10_000 });

  await pageA.click('#leaveBtn');
  await pageA.waitForSelector('#landingView:not([hidden])');
  await pageB.waitForSelector('#landingView:not([hidden])', { timeout: 10_000 });

  assert.deepEqual(errors, []);

  console.log('');
  console.log('✓ 双页 WebRTC 音频互通');
  console.log('✓ 双向共享、麦克风混合、音量与静音');
  console.log('✓ 强制中继 Opus 音频互通');
  console.log('✓ 移动端布局无横向溢出');
  console.log('✓ 截图：test/artifacts/e2e-*.png');
  console.log('');
} catch (error) {
  console.error('浏览器测试失败：', error);
  if (browser) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (let index = 0; index < pages.length; index += 1) {
      try {
        await pages[index].screenshot({
          path: path.join(ARTIFACTS, 'e2e-failure-' + index + '.png'),
          fullPage: true,
        });
      } catch {
        // Ignore screenshot failures during cleanup.
      }
    }
  }
  if (serverLog) console.error(serverLog);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
}
