import { RelayEngine } from './relay.js';

'use strict';

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  ws: null,
  socketPromise: null,
  heartbeatTimer: null,
  wsReady: false,
  intentionalClose: false,

  selfId: null,
  room: null,
  role: null,
  peerId: null,
  peerSharing: false,
  peerMic: false,

  config: { iceServers: [], secure: false, turnEnabled: false, lanUrls: [], publicUrl: '' },
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  captureSupported: false,

  pc: null,
  sender: null,
  remoteStream: null,
  pendingCandidates: [],
  connectTimeout: null,
  disconnectTimer: null,
  statsTimer: null,
  net: null,

  displayStream: null,
  systemStream: null,
  micStream: null,
  mixCtx: null,
  mixDest: null,
  mixedStream: null,
  systemSource: null,
  micSource: null,
  systemGain: null,
  micGain: null,
  compressor: null,
  localAnalyser: null,
  silent: null,

  sharing: false,
  capturePending: false,
  micWanted: false,
  micActive: false,
  micBusy: false,

  remoteCtx: null,
  remoteSource: null,
  remoteAnalyser: null,
  playBlocked: false,
  volume: 80,
  muted: false,

  entryBusy: null,
  entryTimer: null,
  autoJoinTried: false,
  leaving: false,
  connectionKind: 'waiting',

  relay: null,
  relayActive: false,
  relayStarting: null,
  relaySending: false,
  peerRelay: false,
  forceRelay: false,
  relayFallbackTimer: null,
  relayPacketsSent: 0,
  relayErrorShown: false,
  rafId: null,
  waveData: null,
  freqData: null,
  problemShown: false,
  sessionStartedAt: 0,
  sessionTimer: null,
  localBeatTimer: null,
  remoteBeatTimer: null,
  lastLocalBeat: 0,
  lastRemoteBeat: 0,
  lastReadoutAt: 0,
  alertTimer: null,
};

const els = {};

function collectElements() {
  const ids = [
    'landingView',
    'roomView',
    'createBtn',
    'joinForm',
    'roomInput',
    'joinHint',
    'secureState',
    'helpBtn',
    'helpDialog',
    'closeHelpBtn',
    'helpDoneBtn',
    'roomCode',
    'copyCodeBtn',
    'connPill',
    'connText',
    'peerPresence',
    'sessionTime',
    'eventLog',
    'localLevel',
    'localRhythm',
    'remoteLevel',
    'remoteRhythm',
    'connectionAlert',
    'connectionAlertTitle',
    'connectionAlertDetail',
    'connectionAlertClose',
    'copyInviteBtn',
    'inviteStrip',
    'inviteCode',
    'inviteCopyCode',
    'inviteCopyLink',
    'inviteHint',
    'selfCard',
    'selfRole',
    'selfState',
    'selfBadge',
    'shareBtn',
    'micBtn',
    'localCanvas',
    'remoteCard',
    'remoteRole',
    'remoteState',
    'remoteBadge',
    'remoteCanvas',
    'playRemoteBtn',
    'muteBtn',
    'volumeRange',
    'volumeValue',
    'remoteEmpty',
    'remoteAudio',
    'linkCaption',
    'linkProtocol',
    'latency',
    'reconnectBtn',
    'leaveBtn',
    'roomTip',
    'roomTipText',
    'toast',
    'toastText',
  ];
  for (const id of ids) els[id] = document.getElementById(id);

  els.createLabel = els.createBtn ? els.createBtn.querySelector('.btn-label') : null;
  els.joinLabel = els.joinForm ? els.joinForm.querySelector('button span') : null;
  els.shareLabel = els.shareBtn ? els.shareBtn.querySelector('span') : null;
  els.micTitle = els.micBtn ? els.micBtn.querySelector('.mic-copy b') : null;
  els.micGlyph = els.micBtn ? els.micBtn.querySelector('.mic-glyph use') : null;
  els.selfStateDot = els.selfState ? els.selfState.querySelector('i') : null;
  els.remoteStateDot = els.remoteState ? els.remoteState.querySelector('i') : null;
}

async function init() {
  collectElements();
  initRelayEngine();
  bindEvents();
  loadSavedVolume();
  applyVolume(state.volume, false);
  startVisualizer();
  await loadConfig();
  applySecureUi();
  maybeAutoJoin();
  exposeDebugApi();
}

function initRelayEngine() {
  const params = new URLSearchParams(window.location.search);
  state.forceRelay = params.get('relay') === '1';
  if (!RelayEngine.receiverSupported) return;

  state.relay = new RelayEngine({
    onFrame: (buffer) => {
      if (!state.relayActive || !state.relaySending) return;
      if (sendSocketBinary(buffer)) state.relayPacketsSent += 1;
    },
    onPlayback: (stream) => {
      if (stream) attachRemoteStream(stream);
    },
    onError: (message) => {
      console.warn('[relay]', message);
      if (state.relayActive && !state.relayErrorShown) {
        state.relayErrorShown = true;
        showToast('中继音频出现异常，可尝试刷新页面', 'error', 5000);
      }
    },
    onSenderEnd: () => {
      const wasSending = state.relaySending;
      state.relaySending = false;
      if (wasSending) sendRelayState(false);
      renderRoom();
    },
  });
}

function bindEvents() {
  els.createBtn.addEventListener('click', createRoom);
  els.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    joinRoom(els.roomInput.value);
  });
  els.roomInput.addEventListener('input', () => {
    const normalized = normalizeCode(els.roomInput.value);
    if (els.roomInput.value !== normalized) els.roomInput.value = normalized;
    els.joinForm.classList.remove('invalid');
  });
  els.roomInput.addEventListener('paste', () => {
    window.setTimeout(() => {
      els.roomInput.value = normalizeCode(els.roomInput.value);
    }, 0);
  });

  els.copyCodeBtn.addEventListener('click', copyRoomCode);
  els.copyInviteBtn.addEventListener('click', copyInviteLink);
  els.inviteCopyCode.addEventListener('click', copyRoomCode);
  els.inviteCopyLink.addEventListener('click', copyInviteLink);
  els.shareBtn.addEventListener('click', toggleSharing);
  els.micBtn.addEventListener('click', toggleMic);
  els.leaveBtn.addEventListener('click', leaveRoom);
  els.reconnectBtn.addEventListener('click', reconnectPeer);
  els.playRemoteBtn.addEventListener('click', playRemoteAudio);
  els.muteBtn.addEventListener('click', toggleMute);
  els.volumeRange.addEventListener('input', () => {
    state.volume = Number(els.volumeRange.value);
    state.muted = state.volume === 0;
    applyVolume(state.volume);
    saveVolume();
  });
  els.remoteAudio.addEventListener('playing', () => {
    state.playBlocked = false;
    renderRoom();
  });
  els.remoteAudio.addEventListener('error', () => {
    if (state.remoteStream) {
      state.playBlocked = true;
      renderRoom();
    }
  });

  els.helpBtn.addEventListener('click', openHelp);
  els.connectionAlertClose.addEventListener('click', hideConnectionAlert);
  els.closeHelpBtn.addEventListener('click', closeHelp);
  els.helpDoneBtn.addEventListener('click', closeHelp);
  els.helpDialog.addEventListener('click', (event) => {
    if (event.target === els.helpDialog) closeHelp();
  });
  els.helpDialog.addEventListener('close', () => {
    document.body.style.overflow = '';
  });

  document.addEventListener(
    'pointerdown',
    () => {
      resumeAudioContexts();
    },
    { passive: true },
  );

  window.addEventListener('beforeunload', () => {
    state.intentionalClose = true;
    try {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'leave' }));
      }
      state.ws?.close();
    } catch {
      // Best effort.
    }
    releaseMedia();
    closeSilentTrack();
    state.relay?.close();
    if (state.pc) state.pc.close();
  });
}

/* --------------------------------------------------------------------------
   Config and environment
   -------------------------------------------------------------------------- */

async function loadConfig() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const config = await response.json();
    state.config = config;
    if (Array.isArray(config.iceServers) && config.iceServers.length) {
      state.iceServers = config.iceServers;
    }
  } catch (error) {
    console.warn('[config] 使用默认 ICE 配置：', error.message);
  }

  state.captureSupported = Boolean(
    navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function' && window.isSecureContext,
  );
}

function applySecureUi() {
  if (!els.secureState) return;
  els.secureState.hidden = false;
  els.secureState.classList.remove('warn');

  if (!window.isSecureContext) {
    els.secureState.classList.add('warn');
    els.secureState.querySelector('span').textContent = '需要 HTTPS';
    els.secureState.title = '浏览器只允许在 HTTPS 页面中采集设备声音';
    return;
  }

  if (window.location.protocol === 'https:') {
    els.secureState.querySelector('span').textContent = '安全连接';
    els.secureState.title = '当前页面通过 HTTPS 打开';
    return;
  }

  els.secureState.hidden = true;
}

function isLoopback() {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function bestInviteBase() {
  if (state.config.publicUrl) return state.config.publicUrl.replace(/\/+$/, '');
  if (
    (isLoopback() || !window.isSecureContext) &&
    Array.isArray(state.config.lanUrls) &&
    state.config.lanUrls.length
  ) {
    return state.config.lanUrls[0].url.replace(/\/+$/, '');
  }
  return window.location.origin;
}

function buildInviteUrl() {
  if (!state.room) return '';
  if (state.config.publicUrl) {
    const url = new URL(bestInviteBase());
    url.searchParams.set('room', state.room);
    url.hash = '';
    return url.toString();
  }
  return bestInviteBase() + window.location.pathname + '?room=' + encodeURIComponent(state.room);
}

function maybeAutoJoin() {
  const params = new URLSearchParams(window.location.search);
  const code = normalizeCode(params.get('room') || '');
  if (!code) return;

  els.roomInput.value = code;
  state.autoJoinTried = true;
  window.setTimeout(() => {
    if (state.room || state.entryBusy) return;
    joinRoom(code, { auto: true });
  }, 320);
}

/* --------------------------------------------------------------------------
   Entry / room lifecycle
   -------------------------------------------------------------------------- */

function normalizeCode(value) {
  return String(value || '')
    .replace(/[^0-9a-zA-Z]/g, '')
    .toUpperCase()
    .slice(0, 6);
}

async function createRoom() {
  if (state.entryBusy || state.room) return;
  setEntryBusy('create');
  try {
    await loadConfig();
    const socket = await connectSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('信令连接不可用');
    socket.send(JSON.stringify({ type: 'create' }));
  } catch (error) {
    setEntryBusy(null);
    showToast('无法连接服务器：' + (error.message || '请稍后重试'), 'error', 5000);
  }
}

async function joinRoom(rawCode, options = {}) {
  if (state.entryBusy || state.room) return;
  const code = normalizeCode(rawCode);
  els.roomInput.value = code;

  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    els.joinForm.classList.add('invalid');
    els.roomInput.focus();
    showToast('请输入 6 位房间码（不含 0、1、I、O）', 'error');
    return;
  }

  setEntryBusy('join');
  try {
    await loadConfig();
    const socket = await connectSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('信令连接不可用');
    socket.send(JSON.stringify({ type: 'join', room: code }));
  } catch (error) {
    setEntryBusy(null);
    showToast('加入失败：' + (error.message || '请稍后重试'), 'error', 5000);
    if (options.auto) clearAutoJoinParam();
  }
}

function setEntryBusy(kind) {
  state.entryBusy = kind;
  if (!els.createBtn || !els.joinLabel) return;

  if (kind) {
    els.createBtn.disabled = true;
    els.joinForm.querySelector('button').disabled = true;
    els.createLabel.textContent = kind === 'create' ? '正在创建房间…' : '创建声音房间';
    els.joinLabel.textContent = kind === 'join' ? '加入中…' : '加入';
    armEntryTimeout();
  } else {
    els.createBtn.disabled = false;
    els.joinForm.querySelector('button').disabled = false;
    els.createLabel.textContent = '创建声音房间';
    els.joinLabel.textContent = '加入';
    clearTimeout(state.entryTimer);
    state.entryTimer = null;
  }
}

function armEntryTimeout() {
  clearTimeout(state.entryTimer);
  state.entryTimer = window.setTimeout(() => {
    if (!state.entryBusy) return;
    setEntryBusy(null);
    showToast('服务器响应超时，请检查网络后重试', 'error');
    if (state.autoJoinTried) clearAutoJoinParam();
  }, 10_000);
}

function clearAutoJoinParam() {
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function showRoomView() {
  els.landingView.hidden = true;
  els.roomView.hidden = false;
  window.scrollTo(0, 0);
}

function showLandingView() {
  els.roomView.hidden = true;
  els.landingView.hidden = false;
  document.title = '声桥 SoundBridge · 把此刻的声音递给远方的人';
  window.scrollTo(0, 0);
}

function enterRoomState(message) {
  state.room = message.room;
  state.selfId = message.selfId || state.selfId;
  state.role = message.role;
  state.peerId = message.peer?.id || null;
  state.peerSharing = Boolean(message.peer?.sharing);
  state.peerMic = Boolean(message.peer?.mic);
  state.peerRelay = Boolean(message.peer?.relay);
  state.problemShown = false;
  state.autoJoinTried = false;

  const url = new URL(window.location.href);
  url.searchParams.set('room', state.room);
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);

  startSessionClock();
  if (els.eventLog) els.eventLog.replaceChildren();
  setPeerPresence(state.peerId ? 'online' : 'offline', state.peerId ? '对方已连接' : '等待对方');
  logEvent(
    'info',
    state.role === 'host' ? '房间已创建' : '已加入房间',
    '房间码 ' + state.room,
  );
  if (state.role === 'guest' && state.peerId) {
    showConnectionAlert('connected', '已进入声音房间', '房主已在房间中');
  }

  showRoomView();
  renderRoom();

  if (state.peerId) {
    setConnection('connecting', '对方已加入 · 正在连接');
    hideInviteStrip();
    armConnectTimeout();
    prepareRelayPath();
  } else {
    setConnection('waiting', '等待对方加入');
  }

  if (!window.isSecureContext) {
    showRoomTip('当前页面不是 HTTPS，浏览器会阻止采集设备声音。请改用 HTTPS 地址打开，或参考使用说明配置证书。');
  }
}

async function leaveRoom() {
  if (state.leaving) return;
  if (!state.room) {
    showLandingView();
    return;
  }

  state.leaving = true;
  state.intentionalClose = true;

  try {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'leave' }));
    }
  } catch {
    // Ignore.
  }

  await stopSharing({ notify: false, silent: true });
  deactivateRelay({ notify: false });
  teardownPeer();
  closeSilentTrack();
  closeSocketSoon();
  stopSessionClock();
  hideConnectionAlert();
  setPeerPresence('offline', '已离开房间');

  state.room = null;
  state.role = null;
  state.peerId = null;
  state.peerSharing = false;
  state.peerMic = false;
  state.leaving = false;

  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);

  setEntryBusy(null);
  showLandingView();
  renderRoom();
  showToast('已离开房间');
}

function closeSocketSoon() {
  const socket = state.ws;
  state.ws = null;
  state.wsReady = false;
  stopHeartbeat();
  if (socket) {
    window.setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Ignore.
      }
    }, 80);
  }
}

async function handleRoomClosed(message) {
  await stopSharing({ notify: false, silent: true });
  deactivateRelay({ notify: false });
  teardownPeer();
  closeSilentTrack();
  stopSessionClock();
  hideConnectionAlert();
  setPeerPresence('offline', '房间已关闭');

  state.room = null;
  state.role = null;
  state.peerId = null;
  state.peerSharing = false;
  state.peerMic = false;

  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);

  showLandingView();
  renderRoom();
  setEntryBusy(null);

  if (message.reason === 'expired') {
    showToast('房间已过期，请重新创建', 'error');
  } else {
    showToast('房主已离开，房间已关闭', 'error');
  }
}

/* --------------------------------------------------------------------------
   WebSocket signaling
   -------------------------------------------------------------------------- */

function connectSocket() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    return Promise.resolve(state.ws);
  }
  if (state.socketPromise) return state.socketPromise;

  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = scheme + '//' + window.location.host + '/ws';

  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      reject(error);
      return;
    }

    state.ws = ws;
    state.wsReady = false;
    state.intentionalClose = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const timer = window.setTimeout(() => {
      fail(new Error('连接超时'));
      try {
        ws.close();
      } catch {
        // Ignore.
      }
    }, 8_000);

    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.wsReady = true;
      try {
        ws.binaryType = 'arraybuffer';
      } catch {
        // Ignore.
      }
      startHeartbeat();
      resolve(ws);
    });

    ws.addEventListener('message', (event) => {
      if (state.ws !== ws) return;
      if (typeof event.data !== 'string') {
        handleRelayBinary(event.data).catch((error) => console.warn('[relay-packet]', error));
        return;
      }
      handleSocketMessage(event);
    });

    ws.addEventListener('error', () => {
      // The close event delivers the actionable error.
    });

    ws.addEventListener('close', () => {
      clearTimeout(timer);
      const wasCurrent = state.ws === ws;
      if (wasCurrent) {
        state.ws = null;
        state.wsReady = false;
        stopHeartbeat();
      }
      fail(new Error('无法连接信令服务器'));

      if (!wasCurrent || state.intentionalClose) return;

      if (state.room) {
        if (state.relayActive) deactivateRelay({ notify: false });
        setConnection('error', '信令已断开');
        setPeerPresence('error', '对方状态未知');
        showConnectionAlert('disconnected', '信令连接已断开', '已经建立的声音通道可能仍会继续');
        logEvent('error', '信令连接已断开', '请刷新页面重新加入');
        els.reconnectBtn.hidden = true;
        showRoomTip('与信令服务器的连接已断开。已经建立的点对点声音可能仍会继续；离开房间后重新创建即可恢复。');
        showToast('信令连接已断开', 'error', 4500);
      } else if (state.entryBusy) {
        setEntryBusy(null);
        showToast('无法连接信令服务器，请稍后重试', 'error');
      }
    });
  });

  state.socketPromise = promise;
  promise
    .catch(() => {})
    .finally(() => {
      if (state.socketPromise === promise) state.socketPromise = null;
    });
  return promise;
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = window.setInterval(() => {
    if (!sendSocket({ type: 'ping' })) stopHeartbeat();
  }, 20_000);
}

function stopHeartbeat() {
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

function sendSocket(payload) {
  const socket = state.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function sendSignal(data) {
  return sendSocket({ type: 'signal', data });
}

function sendSocketBinary(buffer) {
  const socket = state.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(buffer);
    return true;
  } catch {
    return false;
  }
}

function sendRelayState(active) {
  if (!state.peerId) return false;
  return sendSocket({ type: 'relay-state', active: Boolean(active) });
}

function publishState() {
  if (!state.room) return;
  sendSocket({
    type: 'state',
    sharing: state.sharing,
    mic: state.micActive,
  });
}

async function handleSocketMessage(event) {
  let message;
  try {
    message = JSON.parse(String(event.data));
  } catch {
    return;
  }
  if (!message || typeof message.type !== 'string') return;

  switch (message.type) {
    case 'hello':
      state.selfId = message.selfId;
      break;

    case 'created':
      enterRoomState(message);
      setEntryBusy(null);
      showToast('房间已创建，把邀请发给对方吧');
      break;

    case 'joined':
      enterRoomState(message);
      setEntryBusy(null);
      renderRoom();
      showToast('已加入房间');
      if (
        message.initiate &&
        state.peerId &&
        !state.forceRelay &&
        !state.peerRelay &&
        !state.relayActive
      ) {
        window.setTimeout(() => {
          makeOffer().catch((error) => console.warn('[offer]', error));
        }, 120);
      }
      break;

    case 'peer-joined':
      handlePeerJoined(message);
      break;

    case 'peer-left':
      handlePeerLeft(message);
      break;

    case 'peer-state': {
      const wasSharing = state.peerSharing;
      state.peerSharing = Boolean(message.sharing);
      state.peerMic = Boolean(message.mic);
      if (wasSharing !== state.peerSharing) {
        logEvent(
          state.peerSharing ? 'success' : 'info',
          state.peerSharing ? '对方开始共享' : '对方停止共享',
          state.peerSharing && state.peerMic ? '包含麦克风' : '',
        );
        if (state.peerSharing) showToast('对方开始共享声音');
      }
      renderRoom();
      break;
    }

    case 'peer-relay':
      state.peerRelay = Boolean(message.active);
      if (state.peerRelay) {
        activateRelay('peer').catch((error) => console.warn('[relay-activate]', error));
      }
      renderRoom();
      break;

    case 'signal':
      try {
        await handleSignal(message.data);
      } catch (error) {
        console.warn('[signal]', error);
        markConnectionProblem('建立连接时遇到问题，请点击“重新连接”再试一次。');
      }
      break;

    case 'room-closed':
      handleRoomClosed(message).catch((error) => console.warn('[room-closed]', error));
      break;

    case 'left':
      break;

    case 'error':
      handleServerError(message);
      break;

    case 'pong':
      break;

    default:
      break;
  }
}

function handleServerError(message) {
  setEntryBusy(null);
  showToast(message.message || '操作失败，请稍后重试', 'error', 4500);
  if (state.autoJoinTried) {
    clearAutoJoinParam();
    state.autoJoinTried = false;
  }
}

/* --------------------------------------------------------------------------
   Peer lifecycle
   -------------------------------------------------------------------------- */

function handlePeerJoined(message) {
  state.peerId = message.peer?.id || null;
  state.peerSharing = Boolean(message.peer?.sharing);
  state.peerMic = Boolean(message.peer?.mic);
  state.peerRelay = Boolean(message.peer?.relay);
  state.problemShown = false;

  hideInviteStrip();
  if (state.peerId) {
    setConnection('connecting', '对方已加入 · 正在连接');
    setPeerPresence('online', '对方已连接');
    showConnectionAlert(
      'connected',
      '对方已连接',
      state.role === 'host' ? '收听方已进入房间' : '房主已进入房间',
    );
    logEvent('success', '对方已连接', state.role === 'host' ? '收听方进入房间' : '房主进入房间');
    armConnectTimeout();
    prepareRelayPath();
    showToast('对方已连接');
  }
  renderRoom();
}

function handlePeerLeft() {
  deactivateRelay({ notify: false });
  teardownPeer();
  state.peerId = null;
  state.peerSharing = false;
  state.peerMic = false;
  state.problemShown = false;
  setConnection('waiting', '等待对方加入');
  setPeerPresence('offline', '对方已断开');
  showConnectionAlert('disconnected', '对方已断开', '声音通道已停止，等待对方重新加入');
  logEvent('error', '对方已断开', '等待重新连接');
  hideRoomTip();
  renderRoom();
  els.reconnectBtn.hidden = true;
  showToast('对方已断开连接', 'error');
}

function prepareRelayPath() {
  if (!state.room || !state.peerId || state.relayActive) return;

  if (state.forceRelay || state.peerRelay) {
    activateRelay(state.forceRelay ? 'forced' : 'peer').catch((error) =>
      console.warn('[relay-prepare]', error),
    );
    return;
  }

  if (state.pc && state.pc.connectionState === 'connected') return;
  scheduleRelayFallback();
}

function scheduleRelayFallback() {
  if (!state.room || !state.peerId || state.relayActive || state.forceRelay || state.peerRelay) return;
  if (state.pc && state.pc.connectionState === 'connected') return;

  clearRelayFallback();
  state.relayFallbackTimer = window.setTimeout(() => {
    if (!state.room || !state.peerId || state.relayActive) return;
    if (state.pc && state.pc.connectionState === 'connected') return;
    activateRelay('auto').catch((error) => console.warn('[relay-fallback]', error));
  }, 6_000);
}

function clearRelayFallback() {
  clearTimeout(state.relayFallbackTimer);
  state.relayFallbackTimer = null;
}

function activateRelay(reason = 'manual') {
  if (state.relayActive) {
    if (state.relay) state.relay.resume().catch(() => {});
    return Promise.resolve(true);
  }
  if (state.relayStarting) return state.relayStarting;

  state.relayStarting = doActivateRelay(reason).finally(() => {
    state.relayStarting = null;
  });
  return state.relayStarting;
}

async function doActivateRelay(reason) {
  if (!state.room || !state.peerId) return false;
  if (!state.relay || !RelayEngine.receiverSupported) {
    showToast('当前浏览器不支持中继模式，请使用电脑版 Chrome 或 Edge', 'error', 6000);
    return false;
  }

  state.relayActive = true;
  state.relayErrorShown = false;
  clearRelayFallback();
  clearTimeout(state.connectTimeout);
  clearTimeout(state.disconnectTimer);

  teardownPeer();
  setConnection('connecting', '正在启用服务器中继');
  hideRoomTip();
  sendRelayState(true);

  try {
    await state.relay.activateReceiver();
    if (state.relay.stats.contextState === 'suspended') {
      state.playBlocked = true;
    }
    if (!state.room || !state.peerId) {
      state.relayActive = false;
      return false;
    }

    if (state.sharing && state.mixedStream) {
      await startRelaySender();
    }

    setConnection('connected', '中继已连接');
    logEvent('relay', '已切换服务器中继', 'WSS + Opus 音频转发');
    showConnectionAlert('info', '已启用服务器中继', '直连未建立，声音将通过服务器转发');
    renderRoom();

    if (reason === 'auto') {
      showToast('直连没有建立，已自动切换到服务器中继', 'success', 4200);
    } else if (reason === 'peer') {
      showToast('对方已切换中继，声音通道正在同步', 'success', 4200);
    } else if (reason === 'forced') {
      showToast('已启用服务器中继');
    }
    return true;
  } catch (error) {
    console.warn('[relay-activate]', error);
    state.relayActive = false;
    state.relaySending = false;
    setConnection('error', '中继不可用');
    showRoomTip('服务器中继启动失败：' + (error.message || '未知错误'));
    showToast('中继模式启动失败，请刷新页面后重试', 'error', 6000);
    return false;
  }
}

function deactivateRelay(options = {}) {
  const notify = options.notify !== false;
  const wasActive = state.relayActive;
  state.relayActive = false;
  state.relaySending = false;
  state.peerRelay = false;
  clearRelayFallback();

  if (notify && wasActive) sendRelayState(false);
  if (state.relay) state.relay.close();
  if (state.remoteStream) clearRemoteStream();
  renderRoom();
}

async function startRelaySender() {
  if (!state.relayActive || !state.sharing || !state.mixedStream || !state.peerId) return false;
  if (!state.relay || state.relaySending) return false;

  try {
    await state.relay.startSender(state.mixedStream.getAudioTracks()[0]);
    state.relaySending = state.relay.senderActive;
    if (!state.relaySending) return false;
    state.relayErrorShown = false;
    sendRelayState(true);
    renderRoom();
    return true;
  } catch (error) {
    console.warn('[relay-sender]', error);
    state.relaySending = false;
    showToast('中继音频编码失败：' + (error.message || '未知错误'), 'error', 5000);
    return false;
  }
}

function stopRelaySender(options = {}) {
  const notify = options.notify !== false;
  const wasSending = state.relaySending;
  state.relaySending = false;
  if (state.relay) state.relay.stopSender();
  if (notify && wasSending) sendRelayState(false);
  renderRoom();
}

async function handleRelayBinary(data) {
  if (!state.room || !state.peerId) return;

  let buffer = null;
  if (data instanceof ArrayBuffer) {
    buffer = data;
  } else if (ArrayBuffer.isView(data)) {
    buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } else if (data instanceof Blob) {
    buffer = await data.arrayBuffer();
  } else {
    return;
  }

  if (!buffer || buffer.byteLength <= 9) return;

  if (!state.relayActive) {
    const active = await activateRelay('packet');
    if (!active) return;
  }

  if (!state.relay) return;
  await state.relay.receivePacket(buffer);
}

function armConnectTimeout() {
  clearTimeout(state.connectTimeout);
  state.connectTimeout = window.setTimeout(() => {
    if (!state.room || !state.peerId) return;
    if (state.pc && state.pc.connectionState === 'connected') return;
    markConnectionProblem('声音通道还没有建立。页面会尝试自动切换到服务器中继；若仍失败，请检查网络。');
  }, 20_000);
}

function markConnectionProblem(message) {
  if (state.relayActive) return;
  if (state.room && state.peerId && state.relay && RelayEngine.receiverSupported) {
    logEvent('info', '直连未建立', '正在尝试服务器中继');
    activateRelay('auto').catch((error) => console.warn('[relay-fallback]', error));
    return;
  }

  setConnection('error', '连接中断');
  logEvent('error', '声音通道中断', '请尝试重新连接');
  showConnectionAlert('disconnected', '连接中断', message);
  els.reconnectBtn.hidden = false;
  showRoomTip(message);
  stopStats();
  if (!state.problemShown) {
    state.problemShown = true;
    showToast('连接没有建立成功，可以点击“重新连接”再试', 'error', 5000);
  }
}

function setConnection(kind, text) {
  const previous = state.connectionKind;
  state.connectionKind = kind;
  if (!els.connPill) return;
  els.connPill.className = 'status-pill ' + kind;
  els.connText.textContent = text;
  els.roomView.classList.toggle('is-connected', kind === 'connected');
  renderLink();

  if (kind === 'connected' && previous !== 'connected') {
    logEvent('success', '声音通道已连接', state.relayActive ? '服务器中继' : 'P2P 直连');
  }

  if (kind === 'connected') {
    els.reconnectBtn.hidden = true;
    hideRoomTip();
  }
  if (kind === 'waiting') {
    els.latency.hidden = true;
    state.net = null;
    renderLink();
  }
}

function renderLink() {
  if (!els.linkCaption) return;

  if (state.relayActive) {
    els.linkCaption.textContent = '服务器中继已连接';
    els.linkProtocol.textContent = 'WSS · Opus';
    els.latency.hidden = true;
    return;
  }

  if (state.connectionKind === 'connected') {
    els.linkCaption.textContent = '声音通道已连接';
    els.linkProtocol.textContent = state.net?.relay ? 'TURN · 加密' : 'P2P · 加密';
    if (state.net && typeof state.net.rttMs === 'number' && state.net.rttMs > 0) {
      els.latency.textContent = 'RTT ' + Math.round(state.net.rttMs) + ' ms';
      els.latency.hidden = false;
    } else {
      els.latency.hidden = true;
    }
    return;
  }

  els.latency.hidden = true;
  if (state.connectionKind === 'connecting') {
    els.linkCaption.textContent = '正在建立声音通道';
    els.linkProtocol.textContent = 'WebRTC · 加密';
  } else if (state.connectionKind === 'error') {
    els.linkCaption.textContent = '声音通道中断';
    els.linkProtocol.textContent = 'WebRTC · 加密';
  } else {
    els.linkCaption.textContent = '等待连接';
    els.linkProtocol.textContent = 'P2P · 端到端';
  }
}

function showRoomTip(text) {
  els.roomTipText.textContent = text;
  els.roomTip.hidden = false;
}

function hideRoomTip() {
  els.roomTip.hidden = true;
}

async function makeOffer() {
  if (!state.room || !state.peerId || state.role !== 'guest') return false;
  if (state.relayActive || state.forceRelay || state.peerRelay) return false;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('信令连接已断开，无法重新建立声音通道', 'error');
    return false;
  }

  try {
    teardownPeer();
    setConnection('connecting', '正在建立连接');
    hideRoomTip();
    state.problemShown = false;

    const pc = createPeerConnection(true);
    const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    state.sender = transceiver.sender;
    preferOpus(transceiver);
    await applyLocalTrackToPeer();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ description: pc.localDescription });
    armConnectTimeout();
    return true;
  } catch (error) {
    console.warn('[offer]', error);
    markConnectionProblem('建立连接失败，请点击“重新连接”再试一次。');
    return false;
  }
}

function createPeerConnection() {
  const pc = new RTCPeerConnection({
    iceServers: state.iceServers,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 2,
  });

  state.pc = pc;
  state.pendingCandidates = [];

  pc.onicecandidate = (event) => {
    if (state.pc !== pc || !event.candidate) return;
    sendSignal({ candidate: event.candidate.toJSON() });
  };

  pc.ontrack = (event) => {
    if (state.pc !== pc || event.track.kind !== 'audio') return;
    state.sender = event.transceiver.sender;
    preferOpus(event.transceiver);
    const stream = event.streams[0] || new MediaStream([event.track]);
    attachRemoteStream(stream);
    applyLocalTrackToPeer().catch((error) => console.warn('[replace-track]', error));
  };

  pc.onconnectionstatechange = () => {
    if (state.pc !== pc) return;
    const connectionState = pc.connectionState;

    if (connectionState === 'connected') {
      clearTimeout(state.connectTimeout);
      clearTimeout(state.disconnectTimer);
      clearRelayFallback();
      state.problemShown = false;
      setConnection('connected', '已连接');
      els.reconnectBtn.hidden = true;
      startStats();
      return;
    }

    if (connectionState === 'failed') {
      markConnectionProblem('点对点连接失败，正在尝试服务器中继；若仍无法连接，请检查网络。');
      return;
    }

    if (connectionState === 'disconnected') {
      setConnection('connecting', '连接不稳定');
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = window.setTimeout(() => {
        if (state.pc === pc && pc.connectionState !== 'connected') {
          markConnectionProblem('连接中断了。可以点击“重新连接”重新建立声音通道。');
        }
      }, 3_500);
      return;
    }

    if (connectionState === 'connecting' && state.connectionKind !== 'connected') {
      setConnection('connecting', '正在建立连接');
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (state.pc !== pc) return;
    if (pc.iceConnectionState === 'failed') {
      markConnectionProblem('网络连接失败，正在尝试服务器中继；若仍无法连接，请刷新页面重试。');
    }
  };

  return pc;
}

async function handleSignal(data) {
  if (!state.room || !data || typeof data !== 'object') return;

  if (data.control === 'renegotiate') {
    if (state.role === 'guest') await makeOffer();
    return;
  }

  if (data.description && data.description.type === 'offer') {
    await acceptOffer(data.description);
    return;
  }

  if (data.description && data.description.type === 'answer') {
    if (!state.pc) return;
    await state.pc.setRemoteDescription(data.description);
    await flushPendingCandidates();
    return;
  }

  if (data.candidate && data.candidate.candidate) {
    if (!state.pc || !state.pc.remoteDescription) {
      state.pendingCandidates.push(data.candidate);
      return;
    }
    try {
      await state.pc.addIceCandidate(data.candidate);
    } catch (error) {
      console.warn('[ice]', error.message);
    }
  }
}

async function acceptOffer(description) {
  try {
    teardownPeer();
    setConnection('connecting', '对方已加入 · 正在连接');
    hideRoomTip();
    state.problemShown = false;

    const pc = createPeerConnection(false);
    await pc.setRemoteDescription(description);
    captureAnswererSender(pc);
    await applyLocalTrackToPeer();
    await flushPendingCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ description: pc.localDescription });
    armConnectTimeout();
  } catch (error) {
    console.warn('[answer]', error);
    markConnectionProblem('接听声音通道时出错，请点击“重新连接”再试一次。');
  }
}

function captureAnswererSender(pc) {
  const transceiver = pc
    .getTransceivers()
    .find((item) => item.receiver?.track?.kind === 'audio' || item.sender?.track?.kind === 'audio');
  if (!transceiver) return;
  state.sender = transceiver.sender;
  preferOpus(transceiver);
}

async function flushPendingCandidates() {
  if (!state.pc || !state.pc.remoteDescription) return;
  const candidates = state.pendingCandidates.splice(0);
  for (const candidate of candidates) {
    try {
      await state.pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn('[ice-flush]', error.message);
    }
  }
}

function preferOpus(transceiver) {
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
  if (!window.RTCRtpSender || typeof RTCRtpSender.getCapabilities !== 'function') return;

  try {
    const capabilities = RTCRtpSender.getCapabilities('audio');
    if (!capabilities || !capabilities.codecs) return;
    const opus = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() === 'audio/opus');
    if (!opus.length) return;
    const others = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() !== 'audio/opus');
    transceiver.setCodecPreferences([...opus, ...others]);
  } catch (error) {
    console.warn('[codec]', error.message);
  }
}

async function applyLocalTrackToPeer() {
  if (!state.pc || state.pc.signalingState === 'closed' || !state.sender) return;
  ensureTransceiverSendRecv(state.pc);

  const useMixed = Boolean(state.sharing && state.mixedStream);
  let track = useMixed ? state.mixedStream.getAudioTracks()[0] : null;
  let stream = useMixed ? state.mixedStream : null;

  if (!track) {
    track = ensureSilentTrack();
    stream = state.silent ? state.silent.stream : null;
  }

  if (!track) return;

  try {
    await state.sender.replaceTrack(track);
  } catch (error) {
    console.warn('[replace-track]', error.message);
    return;
  }

  try {
    if (typeof state.sender.setStreams === 'function' && stream) {
      state.sender.setStreams(stream);
    }
  } catch {
    // setStreams is an optimization, not a requirement.
  }
  configureSender(state.sender);
}

function ensureTransceiverSendRecv(pc) {
  const transceiver = pc
    .getTransceivers()
    .find((item) => item.receiver?.track?.kind === 'audio' || item.sender?.track?.kind === 'audio');
  if (!transceiver || transceiver.direction === 'sendrecv') return;
  try {
    transceiver.direction = 'sendrecv';
  } catch {
    // Direction changes are best effort; keep the negotiated direction.
  }
}

function ensureSilentTrack() {
  if (state.silent && state.silent.track && state.silent.track.readyState === 'live') {
    return state.silent.track;
  }

  closeSilentTrack();

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    const context = new AudioCtx();
    const destination = context.createMediaStreamDestination();
    const gain = context.createGain();
    gain.gain.value = 0;
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 220;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();

    const track = destination.stream.getAudioTracks()[0];
    if (track) track.contentHint = 'music';
    state.silent = {
      context,
      destination,
      gain,
      oscillator,
      track,
      stream: destination.stream,
    };

    if (context.state === 'suspended') context.resume().catch(() => {});
    return track;
  } catch (error) {
    console.warn('[silent-track]', error.message);
    return null;
  }
}

function closeSilentTrack() {
  if (!state.silent) return;
  const silent = state.silent;
  state.silent = null;
  try {
    silent.oscillator.stop();
  } catch {
    // Ignore.
  }
  try {
    silent.track.stop();
  } catch {
    // Ignore.
  }
  if (silent.context && silent.context.state !== 'closed') {
    silent.context.close().catch(() => {});
  }
}

function configureSender(sender) {
  if (!sender || sender.__soundbridgeConfigured) return;
  sender.__soundbridgeConfigured = true;
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings || !parameters.encodings.length) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = 128_000;
    parameters.encodings[0].networkPriority = 'high';
    sender.setParameters(parameters).catch(() => {});
  } catch {
    // Older browsers may not support changing sender parameters.
  }
}

function teardownPeer() {
  clearTimeout(state.connectTimeout);
  clearTimeout(state.disconnectTimer);
  state.connectTimeout = null;
  state.disconnectTimer = null;
  stopStats();

  if (state.pc) {
    try {
      state.pc.onicecandidate = null;
      state.pc.ontrack = null;
      state.pc.onconnectionstatechange = null;
      state.pc.oniceconnectionstatechange = null;
      state.pc.close();
    } catch {
      // Ignore.
    }
  }

  state.pc = null;
  state.sender = null;
  state.pendingCandidates = [];
  state.net = null;
  clearRemoteStream();
}

function reconnectPeer() {
  if (!state.room || !state.peerId) return;
  if (state.relayActive) {
    showToast('当前正在使用服务器中继；如仍听不到，请刷新页面重新加入');
    return;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('信令连接已断开，请离开房间后重新创建', 'error');
    return;
  }

  if (state.role === 'guest') {
    makeOffer().catch((error) => console.warn('[reconnect]', error));
    return;
  }

  const sent = sendSignal({ control: 'renegotiate' });
  if (!sent) {
    showToast('无法通知对方重连，请检查网络', 'error');
    return;
  }
  setConnection('connecting', '正在请求对方重连');
  els.reconnectBtn.hidden = true;
  state.problemShown = false;
  armConnectTimeout();
  showToast('已请求对方重新建立连接');
}

/* --------------------------------------------------------------------------
   Remote audio
   -------------------------------------------------------------------------- */

function attachRemoteStream(stream) {
  state.remoteStream = stream;
  state.playBlocked = false;
  els.remoteAudio.srcObject = stream;
  applyPlaybackVolume();

  const playPromise = els.remoteAudio.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      state.playBlocked = true;
      renderRoom();
    });
  }

  setupRemoteAnalyser(stream);
  renderRoom();
}

function setupRemoteAnalyser(stream) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!state.remoteCtx || state.remoteCtx.state === 'closed') {
      state.remoteCtx = new AudioCtx();
    }
    if (state.remoteCtx.state === 'suspended') {
      state.remoteCtx.resume().catch(() => {});
    }
    if (state.remoteSource) {
      try {
        state.remoteSource.disconnect();
      } catch {
        // Ignore.
      }
    }
    const source = state.remoteCtx.createMediaStreamSource(stream);
    const analyser = state.remoteCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;
    source.connect(analyser);
    state.remoteSource = source;
    state.remoteAnalyser = analyser;
  } catch (error) {
    console.warn('[remote-analyser]', error.message);
  }
}

function clearRemoteStream() {
  try {
    els.remoteAudio.pause();
  } catch {
    // Ignore.
  }
  els.remoteAudio.srcObject = null;
  state.remoteStream = null;
  state.playBlocked = false;

  if (state.remoteSource) {
    try {
      state.remoteSource.disconnect();
    } catch {
      // Ignore.
    }
  }
  state.remoteSource = null;
  state.remoteAnalyser = null;

  if (state.remoteCtx && state.remoteCtx.state !== 'closed') {
    state.remoteCtx.close().catch(() => {});
  }
  state.remoteCtx = null;
}

async function playRemoteAudio() {
  try {
    if (state.relay) await state.relay.resume();
    await els.remoteAudio.play();
    state.playBlocked = false;
    renderRoom();
  } catch {
    showToast('浏览器仍然阻止了播放，请再次点击页面后重试', 'error');
  }
}

function loadSavedVolume() {
  try {
    const raw = window.localStorage.getItem('soundbridge-volume');
    if (raw === null || raw === '') return;
    const saved = Number(raw);
    if (Number.isFinite(saved) && saved >= 0 && saved <= 100) state.volume = saved;
  } catch {
    // Ignore storage failures.
  }
}

function saveVolume() {
  try {
    window.localStorage.setItem('soundbridge-volume', String(state.volume));
  } catch {
    // Ignore storage failures.
  }
}

function applyVolume(value, render = true) {
  const volume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  state.volume = volume;
  els.volumeRange.value = String(volume);
  els.volumeRange.style.setProperty('--volume', String(volume));
  els.volumeValue.textContent = volume + '%';

  if (!state.muted && volume === 0) state.muted = true;
  if (!state.muted && volume > 0) {
    // Keep the muted state as-is; changing the slider itself unmutes.
  }

  applyPlaybackVolume();
  if (render) renderRoom();
}

function applyPlaybackVolume() {
  const effective = state.muted ? 0 : state.volume / 100;
  els.remoteAudio.volume = Math.max(0, Math.min(1, effective));
}

function toggleMute() {
  if (!state.remoteStream) return;
  if (state.muted) {
    state.muted = false;
    if (state.volume === 0) state.volume = 60;
  } else {
    state.muted = true;
  }
  applyVolume(state.volume);
  saveVolume();
}

function resumeAudioContexts() {
  if (state.relay) state.relay.resume().catch(() => {});
  for (const context of [state.mixCtx, state.remoteCtx, state.silent?.context]) {
    if (context && context.state === 'suspended') {
      context.resume().catch(() => {});
    }
  }
}

/* --------------------------------------------------------------------------
   Local capture and mixing
   -------------------------------------------------------------------------- */

async function toggleSharing() {
  if (state.capturePending) return;
  if (state.sharing) {
    await stopSharing({ notify: true, silent: false });
    return;
  }
  await startSharing();
}

async function startSharing() {
  if (state.sharing || state.capturePending) return;

  if (!window.isSecureContext) {
    showToast('浏览器只允许在 HTTPS 页面中采集设备声音。请使用 HTTPS 地址打开。', 'error', 6000);
    openHelp();
    return;
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    showToast('当前浏览器不支持采集系统声音，请使用电脑版 Chrome 或 Edge', 'error', 6000);
    openHelp();
    return;
  }

  state.capturePending = true;
  renderRoom();

  let displayStream = null;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 1, max: 5 },
        width: { max: 640 },
        height: { max: 360 },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
    });

    const audioTracks = displayStream.getAudioTracks();
    if (!audioTracks.length) {
      for (const track of displayStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore.
        }
      }
      const error = new Error('未获取到系统声音');
      error.code = 'NO_SYSTEM_AUDIO';
      throw error;
    }

    if (!state.room) {
      for (const track of displayStream.getTracks()) track.stop();
      return;
    }

    state.displayStream = displayStream;
    // The video track is intentionally kept alive: browsers tie system-audio
    // capture to the screen-share session. It is disabled and never sent.
    for (const track of displayStream.getVideoTracks()) {
      track.enabled = false;
    }
    state.systemStream = new MediaStream(audioTracks);
    state.systemStream.getAudioTracks()[0].contentHint = 'music';

    await ensureMixer();
    state.systemSource = state.mixCtx.createMediaStreamSource(state.systemStream);
    state.systemSource.connect(state.systemGain);

    state.sharing = true;
    state.mixDest.stream.getAudioTracks()[0].contentHint = 'music';
    state.mixedStream = state.mixDest.stream;

    if (state.micWanted) {
      try {
        await enableMicInternal();
      } catch (error) {
        state.micWanted = false;
        state.micActive = false;
        showToast('麦克风不可用，已改为仅共享设备声音', 'error', 4500);
        console.warn('[mic]', error.message);
      }
    }

    watchDisplayTracks(displayStream);
    await applyLocalTrackToPeer();
    if (state.relayActive) await startRelaySender();
    publishState();
    renderRoom();
    logEvent('info', '开始共享', state.micActive ? '设备声音 + 麦克风' : '设备声音');
    showToast(state.micActive ? '正在共享设备声音和麦克风' : '正在共享设备声音');
  } catch (error) {
    if (displayStream) {
      for (const track of displayStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore.
        }
      }
    }
    releaseMedia();
    state.sharing = false;
    state.micActive = false;
    handleCaptureError(error);
  } finally {
    state.capturePending = false;
    renderRoom();
  }
}

function watchDisplayTracks(stream) {
  const onEnded = () => {
    if (state.displayStream !== stream || !state.sharing) return;
    stopSharing({ notify: true, silent: true }).then(() => {
      showToast('系统声音共享已结束', 'error');
    });
  };

  for (const track of stream.getTracks()) {
    track.addEventListener('ended', onEnded, { once: true });
  }
}

function handleCaptureError(error) {
  console.warn('[capture]', error);

  if (error && error.code === 'NO_SYSTEM_AUDIO') {
    showToast('没有获取到系统声音。请在弹窗中选择“整个屏幕”，并勾选“分享系统音频”。', 'error', 7000);
    window.setTimeout(openHelp, 450);
    return;
  }

  if (error && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError')) {
    showToast('你取消了共享，或浏览器拒绝了屏幕采集权限', 'error');
    return;
  }

  if (error && error.name === 'NotFoundError') {
    showToast('没有找到可共享的屏幕或音频源', 'error');
    return;
  }

  if (error && error.name === 'NotSupportedError') {
    showToast('当前浏览器不支持采集系统声音，请改用电脑版 Chrome 或 Edge', 'error', 6000);
    openHelp();
    return;
  }

  showToast('开始共享失败：' + (error.message || '未知错误'), 'error', 5000);
}

async function stopSharing(options = {}) {
  const notify = options.notify !== false;
  const silent = Boolean(options.silent);
  if (!state.sharing && !state.displayStream && !state.micStream) {
    state.capturePending = false;
    return;
  }

  state.sharing = false;
  state.micActive = false;
  state.micWanted = false;
  state.micBusy = false;
  stopRelaySender();

  try {
    await applyLocalTrackToPeer();
  } catch {
    // The peer may already be gone.
  }

  releaseMedia();
  renderRoom();

  if (notify) publishState();
  if (state.room) logEvent('info', '停止共享', '已停止发送设备声音');
  if (!silent) showToast('已停止共享声音');
}

function releaseMedia() {
  if (state.displayStream) {
    for (const track of state.displayStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore.
      }
    }
  }
  if (state.systemStream) {
    for (const track of state.systemStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore.
      }
    }
  }
  if (state.micStream) {
    for (const track of state.micStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore.
      }
    }
  }

  state.displayStream = null;
  state.systemStream = null;
  state.micStream = null;
  state.systemSource = null;
  state.micSource = null;

  if (state.mixCtx && state.mixCtx.state !== 'closed') {
    state.mixCtx.close().catch(() => {});
  }
  state.mixCtx = null;
  state.mixDest = null;
  state.mixedStream = null;
  state.systemGain = null;
  state.micGain = null;
  state.compressor = null;
  state.localAnalyser = null;
}

async function ensureMixer() {
  if (state.mixCtx && state.mixCtx.state !== 'closed') return;

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('浏览器不支持 Web Audio');

  const context = new AudioCtx();
  if (context.state === 'suspended') {
    await context.resume().catch(() => {});
  }

  const destination = context.createMediaStreamDestination();
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 18;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.24;

  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.82;

  const systemGain = context.createGain();
  systemGain.gain.value = 0.9;

  const micGain = context.createGain();
  micGain.gain.value = 0.72;

  systemGain.connect(compressor);
  micGain.connect(compressor);
  compressor.connect(analyser);
  analyser.connect(destination);

  state.mixCtx = context;
  state.mixDest = destination;
  state.compressor = compressor;
  state.localAnalyser = analyser;
  state.systemGain = systemGain;
  state.micGain = micGain;
}

async function enableMicInternal() {
  if (state.micStream && state.micSource) return;

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    throw new Error('浏览器不支持麦克风采集');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  if (!state.mixCtx || state.mixCtx.state === 'closed') {
    for (const track of stream.getTracks()) track.stop();
    throw new Error('音频混音器尚未准备好');
  }

  state.micStream = stream;
  state.micSource = state.mixCtx.createMediaStreamSource(stream);
  state.micSource.connect(state.micGain);
  state.micActive = true;

  const micTrack = stream.getAudioTracks()[0];
  if (micTrack) {
    micTrack.addEventListener(
      'ended',
      () => {
        if (!state.sharing) return;
        disableMicInternal();
        publishState();
        renderRoom();
        showToast('麦克风已断开');
      },
      { once: true },
    );
  }
}

function disableMicInternal() {
  if (state.micSource) {
    try {
      state.micSource.disconnect();
    } catch {
      // Ignore.
    }
  }
  state.micSource = null;
  if (state.micStream) {
    for (const track of state.micStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore.
      }
    }
  }
  state.micStream = null;
  state.micActive = false;
}

async function toggleMic() {
  if (state.micBusy || state.capturePending) return;

  if (!state.sharing) {
    state.micWanted = !state.micWanted;
    renderRoom();
    showToast(state.micWanted ? '开始共享设备声音时会同时请求麦克风' : '已取消共享麦克风');
    return;
  }

  if (state.micActive) {
    disableMicInternal();
    state.micWanted = false;
    publishState();
    renderRoom();
    showToast('已关闭麦克风');
    return;
  }

  state.micBusy = true;
  state.micWanted = true;
  renderRoom();

  try {
    await enableMicInternal();
    publishState();
    showToast('麦克风已加入共享');
  } catch (error) {
    state.micWanted = false;
    state.micActive = false;
    console.warn('[mic]', error);
    if (error.name === 'NotAllowedError') {
      showToast('麦克风权限被拒绝', 'error');
    } else if (error.name === 'NotFoundError') {
      showToast('没有找到可用的麦克风', 'error');
    } else {
      showToast('无法打开麦克风：' + (error.message || '未知错误'), 'error');
    }
  } finally {
    state.micBusy = false;
    renderRoom();
  }
}

/* --------------------------------------------------------------------------
   Stats
   -------------------------------------------------------------------------- */

function startStats() {
  stopStats();
  const tick = async () => {
    if (state.connectionKind !== 'connected') return;
    const metrics = await collectStats();
    if (!metrics) return;
    state.net = metrics;
    renderLink();
  };
  tick();
  state.statsTimer = window.setInterval(tick, 3_500);
}

function stopStats() {
  clearInterval(state.statsTimer);
  state.statsTimer = null;
}

async function collectStats() {
  const pc = state.pc;
  if (!pc || pc.signalingState === 'closed') return null;

  try {
    const report = await pc.getStats();
    let transport = null;
    let selectedPair = null;
    let inboundBytes = 0;
    let inboundPackets = 0;

    report.forEach((entry) => {
      if (entry.type === 'transport' && entry.selectedCandidatePairId) transport = entry;
      if (entry.type === 'inbound-rtp' && (entry.kind === 'audio' || entry.mediaType === 'audio')) {
        inboundBytes += entry.bytesReceived || 0;
        inboundPackets += entry.packetsReceived || 0;
      }
    });

    if (transport) selectedPair = report.get(transport.selectedCandidatePairId);

    if (!selectedPair) {
      report.forEach((entry) => {
        if (
          entry.type === 'candidate-pair' &&
          (entry.selected || entry.nominated) &&
          entry.state === 'succeeded'
        ) {
          selectedPair = entry;
        }
      });
    }

    let rttMs = null;
    let relay = false;

    if (selectedPair) {
      if (typeof selectedPair.currentRoundTripTime === 'number') {
        rttMs = selectedPair.currentRoundTripTime * 1000;
      }
      const localCandidate = selectedPair.localCandidateId
        ? report.get(selectedPair.localCandidateId)
        : null;
      const remoteCandidate = selectedPair.remoteCandidateId
        ? report.get(selectedPair.remoteCandidateId)
        : null;
      relay =
        localCandidate?.candidateType === 'relay' || remoteCandidate?.candidateType === 'relay';
    }

    return {
      rttMs,
      relay,
      bytesReceived: inboundBytes,
      packetsReceived: inboundPackets,
      connectionState: pc.connectionState,
    };
  } catch (error) {
    console.warn('[stats]', error.message);
    return null;
  }
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */

function setPeerPresence(mode, text) {
  if (!els.peerPresence) return;
  els.peerPresence.classList.remove('online', 'offline', 'error');
  els.peerPresence.classList.add(mode);
  const label = els.peerPresence.querySelector('span');
  if (label) label.textContent = text;
}

function showConnectionAlert(type, title, detail) {
  if (!els.connectionAlert) return;
  clearTimeout(state.alertTimer);
  els.connectionAlert.className = 'connection-alert ' + type;
  els.connectionAlertTitle.textContent = title;
  els.connectionAlertDetail.textContent = detail || '';
  const icon = els.connectionAlert.querySelector('use');
  if (icon) {
    icon.setAttribute('href', type === 'connected' ? '#i-check' : type === 'disconnected' ? '#i-x' : '#i-info');
  }
  els.connectionAlert.hidden = false;
  window.requestAnimationFrame(() => {
    els.connectionAlert.classList.add('show');
  });
  state.alertTimer = window.setTimeout(hideConnectionAlert, 5200);
}

function hideConnectionAlert() {
  if (!els.connectionAlert || els.connectionAlert.hidden) return;
  clearTimeout(state.alertTimer);
  els.connectionAlert.classList.remove('show');
  state.alertTimer = window.setTimeout(() => {
    if (!els.connectionAlert.classList.contains('show')) els.connectionAlert.hidden = true;
  }, 320);
}

function logEvent(kind, title, detail) {
  if (!els.eventLog) return;
  const item = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'event-dot ' + kind;
  const time = document.createElement('span');
  time.className = 'event-time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const copy = document.createElement('span');
  copy.className = 'event-copy';
  const strong = document.createElement('b');
  strong.textContent = title;
  copy.appendChild(strong);
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    copy.appendChild(small);
  }
  item.appendChild(dot);
  item.appendChild(time);
  item.appendChild(copy);
  els.eventLog.prepend(item);
  while (els.eventLog.children.length > 8) {
    els.eventLog.removeChild(els.eventLog.lastChild);
  }
}

function formatDuration(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

function renderSessionClock() {
  if (!els.sessionTime) return;
  els.sessionTime.textContent = state.sessionStartedAt
    ? formatDuration(Date.now() - state.sessionStartedAt)
    : '00:00';
}

function startSessionClock() {
  stopSessionClock();
  state.sessionStartedAt = Date.now();
  renderSessionClock();
  state.sessionTimer = window.setInterval(renderSessionClock, 1000);
}

function stopSessionClock() {
  clearInterval(state.sessionTimer);
  state.sessionTimer = null;
  state.sessionStartedAt = 0;
  if (els.sessionTime) els.sessionTime.textContent = '00:00';
}

function triggerBeat(card, timerKey, lastKey) {
  if (!card) return;
  const now = performance.now();
  if (now - state[lastKey] < 300) return;
  state[lastKey] = now;
  clearTimeout(state[timerKey]);
  card.classList.add('is-beat');
  state[timerKey] = window.setTimeout(() => card.classList.remove('is-beat'), 180);
}

function updateAudioReadouts(local, remote) {
  if (!els.localLevel || !els.remoteLevel) return;
  const localActive = state.sharing;
  const remoteActive = state.peerSharing && Boolean(state.remoteStream);

  els.localLevel.textContent = formatLevel(local.level, localActive);
  els.remoteLevel.textContent = formatLevel(remote.level, remoteActive);
  els.localRhythm.textContent = describeRhythm(local, localActive, false);
  els.remoteRhythm.textContent = describeRhythm(remote, remoteActive, true);
  els.selfCard.style.setProperty('--level', local.level.toFixed(3));
  els.remoteCard.style.setProperty('--level', remote.level.toFixed(3));
}

function formatLevel(level, active) {
  if (!active || level < 0.002) return '−∞ dB';
  return Math.round(20 * Math.log10(level)) + ' dB';
}

function describeRhythm(result, active, remote) {
  if (!active) return remote ? '等待声音' : '静默';
  if (result.bass > 0.48 && result.level > 0.025) return '节奏强烈';
  if (result.level > 0.08) return '声音流动';
  if (result.level > 0.015) return '轻声播放';
  return '静默';
}

function paintRhythmCanvas(canvas, analyser, rgb, active, phase) {
  const result = { level: 0, bass: 0 };
  if (!canvas) return result;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return result;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(rect.width * dpr);
  const pixelHeight = Math.round(rect.height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext('2d');
  if (!context) return result;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const width = rect.width;
  const height = rect.height;
  const mid = height / 2;
  const data = state.waveData;
  const frequencies = state.freqData;

  if (analyser && data) analyser.getByteTimeDomainData(data);
  if (analyser && frequencies) analyser.getByteFrequencyData(frequencies);

  const isActive = Boolean(analyser && active);
  if (isActive) {
    let sum = 0;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      const value = (data[index] - 128) / 128;
      sum += value * value;
      count += 1;
    }
    result.level = Math.sqrt(sum / Math.max(1, count));

    if (frequencies) {
      let bass = 0;
      for (let index = 0; index < 12; index += 1) bass += frequencies[index];
      result.bass = bass / (12 * 255);
    }

    const bars = 42;
    const gap = Math.max(1, width * 0.004);
    const barWidth = Math.max(1, (width - gap * (bars - 1)) / bars);
    for (let index = 0; index < bars; index += 1) {
      const mapped = Math.floor(Math.pow(index / bars, 1.6) * 320);
      const value = frequencies ? frequencies[mapped] / 255 : 0;
      const barHeight = 3 + value * height * 0.58;
      const x = index * (barWidth + gap);
      context.fillStyle = 'rgba(' + rgb + ', ' + (0.045 + value * 0.2) + ')';
      context.fillRect(x, height - barHeight, barWidth, barHeight);
    }
  }

  const amplitude = height * (isActive ? 0.34 : 0.07);
  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, 'rgba(' + rgb + ', 0)');
  gradient.addColorStop(0.18, 'rgba(' + rgb + ', ' + (isActive ? 0.6 : 0.15) + ')');
  gradient.addColorStop(0.5, 'rgba(' + rgb + ', ' + (isActive ? 1 : 0.3) + ')');
  gradient.addColorStop(0.82, 'rgba(' + rgb + ', ' + (isActive ? 0.6 : 0.15) + ')');
  gradient.addColorStop(1, 'rgba(' + rgb + ', 0)');

  context.save();
  context.beginPath();
  context.lineWidth = isActive ? 1.8 : 1.2;
  context.strokeStyle = gradient;
  context.shadowColor = 'rgba(' + rgb + ', ' + (isActive ? 0.55 : 0.1) + ')';
  context.shadowBlur = isActive ? 12 : 3;

  const step = 1.6;
  let first = true;
  for (let x = 0; x <= width; x += step) {
    let value;
    if (isActive) {
      const index = Math.min(data.length - 1, Math.max(0, Math.floor((x / width) * (data.length - 1))));
      value = (data[index] - 128) / 128;
      value += Math.sin(x * 0.05 + phase * 1.3) * 0.012;
    } else {
      value = Math.sin(x * 0.028 + phase * 0.75) * 0.58 + Math.sin(x * 0.011 - phase * 0.5) * 0.42;
      value *= 0.42;
    }
    const y = mid + value * amplitude;
    if (first) {
      context.moveTo(x, y);
      first = false;
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();
  context.restore();

  context.save();
  context.beginPath();
  context.lineWidth = 1;
  context.strokeStyle = 'rgba(255, 255, 255, 0.03)';
  context.moveTo(0, mid + 0.5);
  context.lineTo(width, mid + 0.5);
  context.stroke();
  context.restore();

  return result;
}

function paintOrbitCanvas(canvas, analyser, rgb, active, phase) {
  const result = { level: 0, bass: 0 };
  if (!canvas) return result;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return result;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(rect.width * dpr);
  const pixelHeight = Math.round(rect.height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext('2d');
  if (!context) return result;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const width = rect.width;
  const height = rect.height;
  const centerX = width / 2;
  const centerY = height / 2;
  const maxRadius = Math.min(width, height) / 2 - 8;
  const innerRadius = maxRadius * 0.66;
  const data = state.waveData;
  const frequencies = state.freqData;

  if (analyser && data) analyser.getByteTimeDomainData(data);
  if (analyser && frequencies) analyser.getByteFrequencyData(frequencies);

  const isActive = Boolean(analyser && active);
  if (isActive) {
    let sum = 0;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      const value = (data[index] - 128) / 128;
      sum += value * value;
      count += 1;
    }
    result.level = Math.sqrt(sum / Math.max(1, count));
    if (frequencies) {
      let bass = 0;
      for (let index = 0; index < 12; index += 1) bass += frequencies[index];
      result.bass = bass / (12 * 255);
    }
  }

  context.save();
  context.translate(centerX, centerY);

  context.strokeStyle = 'rgba(255, 255, 255, 0.055)';
  context.lineWidth = 1;
  context.beginPath();
  context.arc(0, 0, innerRadius, 0, Math.PI * 2);
  context.stroke();

  context.strokeStyle = 'rgba(' + rgb + ', 0.08)';
  context.beginPath();
  context.arc(0, 0, maxRadius - 1, 0, Math.PI * 2);
  context.stroke();

  const bars = 64;
  const rotation = phase * 0.035;
  context.lineCap = 'round';
  for (let index = 0; index < bars; index += 1) {
    const angle = (index / bars) * Math.PI * 2 - Math.PI / 2 + rotation;
    let value = 0;
    if (isActive && frequencies) {
      const mapped = Math.floor(Math.pow(index / bars, 1.75) * 360);
      value = frequencies[Math.min(frequencies.length - 1, mapped)] / 255;
    }
    const length = isActive ? 2 + value * (maxRadius - innerRadius) * 0.9 : 3;
    const startRadius = innerRadius + 3;
    const endRadius = startRadius + length;
    const x1 = Math.cos(angle) * startRadius;
    const y1 = Math.sin(angle) * startRadius;
    const x2 = Math.cos(angle) * endRadius;
    const y2 = Math.sin(angle) * endRadius;
    context.strokeStyle =
      'rgba(' + rgb + ', ' + (isActive ? 0.24 + value * 0.68 : 0.13) + ')';
    context.lineWidth = isActive ? 2 : 1.2;
    context.shadowColor = isActive ? 'rgba(' + rgb + ', 0.4)' : 'transparent';
    context.shadowBlur = isActive ? 6 : 0;
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
  }
  context.shadowBlur = 0;

  if (isActive && data) {
    context.beginPath();
    context.strokeStyle = 'rgba(' + rgb + ', 0.42)';
    context.lineWidth = 1.2;
    const points = 128;
    for (let index = 0; index <= points; index += 1) {
      const angle = (index / points) * Math.PI * 2 - Math.PI / 2 - rotation * 0.7;
      const dataIndex = Math.min(
        data.length - 1,
        Math.floor((index / points) * (data.length - 1)),
      );
      const value = (data[dataIndex] - 128) / 128;
      const radius = innerRadius - 4 + value * 4;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }

  context.restore();
  return result;
}

function renderRoom() {
  if (!els.roomCode) return;
  if (!state.room) {
    els.roomCode.textContent = '------';
    els.inviteCode.textContent = '------';
    return;
  }

  document.title = '房间 ' + state.room + ' · 声桥 SoundBridge';
  els.roomCode.textContent = state.room;
  els.inviteCode.textContent = state.room;
  els.inviteStrip.classList.toggle('is-hidden', Boolean(state.peerId));

  const peerPresent = Boolean(state.peerId);
  els.selfRole.textContent = state.role === 'host' ? '房主' : '访客';
  els.remoteRole.textContent = peerPresent ? (state.role === 'host' ? '访客' : '房主') : '尚未加入';
  els.selfCard.classList.toggle('has-peer', peerPresent);
  els.remoteCard.classList.toggle('has-peer', peerPresent);
  els.selfCard.classList.toggle('is-live', state.sharing);
  els.remoteCard.classList.toggle('is-live', state.peerSharing);

  let selfText = '未共享';
  let selfBadge = '待机';
  if (state.capturePending) {
    selfText = '正在请求权限';
    selfBadge = '准备中';
  } else if (state.sharing) {
    selfText = state.micActive ? '共享中 · 含麦克风' : '正在共享';
    selfBadge = state.micActive ? '直播中 + 麦克风' : '直播中';
  }
  els.selfState.innerHTML = '<i></i> ' + selfText;
  els.selfState.classList.toggle('active', state.sharing);
  els.selfBadge.textContent = selfBadge;

  let remoteText = '等待加入';
  let remoteBadge = '等待连接';
  if (peerPresent) {
    remoteText = state.peerSharing ? (state.peerMic ? '共享中 · 含麦克风' : '正在共享') : '未共享';
    remoteBadge = state.peerSharing ? '正在共享' : '正在收听';
  }
  els.remoteState.innerHTML = '<i></i> ' + remoteText;
  els.remoteState.classList.toggle('active', state.peerSharing);
  els.remoteBadge.textContent = remoteBadge;

  const hasRemoteAudio = Boolean(state.remoteStream) && state.peerSharing;
  if (hasRemoteAudio) {
    els.remoteEmpty.classList.add('is-hidden');
  } else {
    els.remoteEmpty.classList.remove('is-hidden');
    if (!peerPresent) {
      els.remoteEmpty.textContent = '对方加入并共享后，声音会从这里流进来。';
    } else if (state.peerSharing) {
      els.remoteEmpty.textContent = '正在接收对方的声音…';
    } else {
      els.remoteEmpty.textContent = '对方已加入，等待对方点击共享。';
    }
  }

  els.shareBtn.disabled = state.capturePending;
  els.shareBtn.setAttribute('aria-busy', state.capturePending ? 'true' : 'false');
  const shareText = state.capturePending
    ? '等待浏览器确认…'
    : state.sharing
      ? '停止共享声音'
      : '共享我的设备声音';
  els.shareLabel.textContent = shareText;
  els.shareBtn.querySelector('use').setAttribute('href', state.sharing ? '#i-x' : '#i-monitor');

  const micOn = state.micActive || state.micWanted;
  els.micBtn.setAttribute('aria-pressed', micOn ? 'true' : 'false');
  els.micBtn.disabled = state.capturePending || state.micBusy;
  els.micTitle.textContent = state.micActive
    ? '正在共享麦克风'
    : state.micBusy
      ? '正在打开麦克风…'
      : '同时共享麦克风';
  if (els.micGlyph) els.micGlyph.setAttribute('href', micOn ? '#i-mic' : '#i-mic-off');

  els.volumeRange.disabled = !hasRemoteAudio;
  els.muteBtn.disabled = !hasRemoteAudio;
  els.playRemoteBtn.hidden = !(hasRemoteAudio && state.playBlocked);

  els.muteBtn.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
  els.muteBtn.setAttribute('aria-label', state.muted ? '取消静音' : '静音对方声音');
  els.muteBtn.querySelector('use').setAttribute('href', state.muted ? '#i-volume-off' : '#i-volume');
  els.volumeRange.style.setProperty('--volume', String(state.volume));
  els.volumeValue.textContent = state.volume + '%';

  if (state.peerId) {
    els.inviteHint.hidden = true;
  } else {
    renderInviteHint();
  }

  renderLink();
}

function renderInviteHint() {
  if (!els.inviteHint) return;
  let text = '';

  if (!window.isSecureContext) {
    const lan = state.config.lanUrls && state.config.lanUrls[0];
    text = lan
      ? '当前页面不是 HTTPS，浏览器会阻止采集设备声音。请改用 ' + lan.url + ' 打开。'
      : '当前页面不是 HTTPS，浏览器会阻止采集设备声音。请改用 HTTPS 地址打开。';
  } else if (state.config.publicUrl) {
    text = '邀请链接使用公网地址 ' + state.config.publicUrl + '，对方在任何网络都能打开。';
  } else if (isLoopback()) {
    const lan = state.config.lanUrls && state.config.lanUrls[0];
    if (lan) {
      text = '你正在本机访问。对方可打开局域网地址 ' + lan.url + '；跨网络请部署 HTTPS 公网地址。';
    } else {
      text = '你正在本机访问，对方无法打开 localhost。请改用局域网 IP 或部署 HTTPS 公网地址。';
    }
  } else if (state.config.relayEnabled === false) {
    text = '若双方不在同一网络，声音通道可能需要 TURN 中继才能建立。详见 README 的部署说明。';
  }

  els.inviteHint.textContent = text;
  els.inviteHint.hidden = !text;
}

function hideInviteStrip() {
  els.inviteStrip.classList.add('is-hidden');
  els.inviteHint.hidden = true;
}

/* --------------------------------------------------------------------------
   Clipboard and help
   -------------------------------------------------------------------------- */

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to the legacy path.
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

async function copyRoomCode() {
  if (!state.room) return;
  const copied = await copyText(state.room);
  showToast(copied ? '房间码已复制' : '复制失败，请手动选择房间码', copied ? 'success' : 'error');
}

async function copyInviteLink() {
  if (!state.room) return;
  const url = buildInviteUrl();
  const copied = await copyText(url);
  if (!copied) {
    showToast('复制失败，请手动复制浏览器地址栏', 'error');
    return;
  }

  if (isLoopback() && !state.config.publicUrl && state.config.lanUrls && state.config.lanUrls.length) {
    showToast('已复制局域网邀请链接');
  } else {
    showToast('邀请链接已复制');
  }
}

function openHelp() {
  if (!els.helpDialog.open) {
    els.helpDialog.showModal();
    document.body.style.overflow = 'hidden';
  }
}

function closeHelp() {
  if (els.helpDialog.open) els.helpDialog.close();
  document.body.style.overflow = '';
}

let toastTimer = null;
function showToast(message, type = 'success', duration = 3_300) {
  if (!els.toast || !els.toastText) return;
  clearTimeout(toastTimer);
  els.toastText.textContent = message;
  els.toast.classList.toggle('error', type === 'error');
  els.toast.classList.add('show');
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove('show');
  }, duration);
}

/* --------------------------------------------------------------------------
   Visualizer
   -------------------------------------------------------------------------- */

function startVisualizer() {
  if (state.rafId) return;
  state.waveData = new Uint8Array(2048);
  state.freqData = new Uint8Array(1024);

  const loop = () => {
    state.rafId = window.requestAnimationFrame(loop);
    if (els.roomView.hidden) return;
    const phase = performance.now() / 1000;
    const local = paintOrbitCanvas(
      els.localCanvas,
      state.localAnalyser,
      '255, 132, 99',
      state.sharing,
      phase,
    );
    const remote = paintOrbitCanvas(
      els.remoteCanvas,
      state.remoteAnalyser,
      '111, 227, 208',
      state.peerSharing && Boolean(state.remoteStream),
      phase + 1.7,
    );

    if (state.sharing && local.level > 0.02 && local.bass > 0.45) {
      triggerBeat(els.selfCard, 'localBeatTimer', 'lastLocalBeat');
    }
    if (
      state.peerSharing &&
      state.remoteStream &&
      remote.level > 0.02 &&
      remote.bass > 0.45
    ) {
      triggerBeat(els.remoteCard, 'remoteBeatTimer', 'lastRemoteBeat');
    }

    if (performance.now() - state.lastReadoutAt > 120) {
      state.lastReadoutAt = performance.now();
      updateAudioReadouts(local, remote);
    }
  };

  state.rafId = window.requestAnimationFrame(loop);
}

function paintCanvas(canvas, analyser, rgb, active, phase) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(rect.width * dpr);
  const pixelHeight = Math.round(rect.height * dpr);

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const width = rect.width;
  const height = rect.height;
  const mid = height / 2;
  const data = state.waveData;

  if (analyser && data) analyser.getByteTimeDomainData(data);

  const isActive = Boolean(analyser && active);
  const amplitude = height * (isActive ? 0.36 : 0.075);
  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, 'rgba(' + rgb + ', 0)');
  gradient.addColorStop(0.18, 'rgba(' + rgb + ', ' + (isActive ? 0.55 : 0.18) + ')');
  gradient.addColorStop(0.5, 'rgba(' + rgb + ', ' + (isActive ? 1 : 0.34) + ')');
  gradient.addColorStop(0.82, 'rgba(' + rgb + ', ' + (isActive ? 0.55 : 0.18) + ')');
  gradient.addColorStop(1, 'rgba(' + rgb + ', 0)');

  context.save();
  context.beginPath();
  context.lineWidth = isActive ? 1.7 : 1.2;
  context.strokeStyle = gradient;
  context.shadowColor = 'rgba(' + rgb + ', ' + (isActive ? 0.5 : 0.12) + ')';
  context.shadowBlur = isActive ? 11 : 3;

  const step = 1.6;
  let first = true;
  for (let x = 0; x <= width; x += step) {
    let value;
    if (isActive) {
      const index = Math.min(
        data.length - 1,
        Math.max(0, Math.floor((x / width) * (data.length - 1))),
      );
      value = (data[index] - 128) / 128;
      value += Math.sin(x * 0.05 + phase * 1.3) * 0.012;
    } else {
      value =
        Math.sin(x * 0.028 + phase * 0.75) * 0.58 +
        Math.sin(x * 0.011 - phase * 0.5) * 0.42;
      value *= 0.42;
    }

    const y = mid + value * amplitude;
    if (first) {
      context.moveTo(x, y);
      first = false;
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();
  context.restore();

  context.save();
  context.beginPath();
  context.lineWidth = 1;
  context.strokeStyle = 'rgba(255, 255, 255, 0.035)';
  context.moveTo(0, mid + 0.5);
  context.lineTo(width, mid + 0.5);
  context.stroke();
  context.restore();
}

/* --------------------------------------------------------------------------
   Debug API (used by the browser tests; safe, read-only)
   -------------------------------------------------------------------------- */

function exposeDebugApi() {
  window.SoundBridge = {
    version: '1.0.0',
    getState() {
      return {
        room: state.room,
        role: state.role,
        peerId: state.peerId,
        connectionKind: state.connectionKind,
        pcState: state.pc ? state.pc.connectionState : null,
        wsState: state.ws ? state.ws.readyState : null,
        sharing: state.sharing,
        micActive: state.micActive,
        peerSharing: state.peerSharing,
        peerMic: state.peerMic,
        mode: state.forceRelay ? 'relay' : 'auto',
        relayActive: state.relayActive,
        relaySending: state.relaySending,
        peerRelay: state.peerRelay,
        relayPacketsSent: state.relayPacketsSent,
        relayStats: state.relay ? state.relay.stats : null,
        hasRemoteStream: Boolean(state.remoteStream),
        remoteTracks: state.remoteStream
          ? state.remoteStream.getTracks().map((track) => ({
              kind: track.kind,
              readyState: track.readyState,
              enabled: track.enabled,
            }))
          : [],
        captureSupported: state.captureSupported,
        secureContext: window.isSecureContext,
        inviteUrl: buildInviteUrl(),
        iceServerCount: state.iceServers.length,
        playBlocked: state.playBlocked,
      };
    },
    getStats: collectStats,
    getDiagnostics() {
      const pc = state.pc;
      return {
        relayActive: state.relayActive,
        relaySending: state.relaySending,
        relayStats: state.relay ? state.relay.stats : null,
        senderTrack: state.sender && state.sender.track ? state.sender.track.kind : null,
        senderTrackState: state.sender && state.sender.track ? state.sender.track.readyState : null,
        mixedTrack: state.mixedStream && state.mixedStream.getAudioTracks()[0]
          ? state.mixedStream.getAudioTracks()[0].readyState
          : null,
        transceivers: pc
          ? pc.getTransceivers().map((item) => ({
              mid: item.mid,
              direction: item.direction,
              currentDirection: item.currentDirection,
              senderTrack: item.sender.track ? item.sender.track.kind : null,
              receiverTrack: item.receiver.track ? item.receiver.track.kind : null,
            }))
          : [],
        localSdp: pc && pc.localDescription ? pc.localDescription.sdp : null,
        remoteSdp: pc && pc.remoteDescription ? pc.remoteDescription.sdp : null,
      };
    },
    getInviteUrl: buildInviteUrl,
  };
}

init().catch((error) => {
  console.error('[init]', error);
  if (els.createLabel) els.createLabel.textContent = '初始化失败，请刷新';
});