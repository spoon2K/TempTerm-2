import { auth, db } from './firebase.js';
import {
  ref, set, push, remove, onValue, onChildAdded, onDisconnect, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const SPEAK_THRESHOLD = 10;

function randomId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createVoice(onUpdate) {
  const v = {
    status: 'off',
    token: 0,
    code: null, uid: null, name: '', sid: null,
    stream: null,
    muted: false, deafened: false, mutedBeforeDeafen: false,
    roster: {},
    peers: new Map(),
    speaking: new Set(),
    stops: [],
    queue: Promise.resolve(),
    ctx: null,
    stopLocalMeter: null,
  };

  function emit() {
    const people = Object.keys(v.roster).map(uid => {
      const e = v.roster[uid];
      const you = uid === v.uid;
      const p = v.peers.get(uid);
      let link = 'connecting';
      if (you) link = 'you';
      else if (p) {
        const s = p.pc.connectionState;
        if (s === 'connected') link = 'connected';
        else if (s === 'failed' || s === 'disconnected') link = 'trouble';
      }
      return {
        uid, name: e.name || '?', you, link,
        muted: you ? v.muted : !!e.muted,
        speaking: v.speaking.has(uid),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    onUpdate({ status: v.status, muted: v.muted, deafened: v.deafened, people });
  }

  function setSpeaking(uid, on) {
    if (uid === v.uid && v.muted) on = false;
    if (on === v.speaking.has(uid)) return;
    if (on) v.speaking.add(uid); else v.speaking.delete(uid);
    emit();
  }

  function getCtx() {
    if (!v.ctx) v.ctx = new AudioContext();
    return v.ctx;
  }

  function meter(stream, cb) {
    const ctx = getCtx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let on = false;
    let lastLoud = 0;
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      const now = Date.now();
      if (peak > SPEAK_THRESHOLD) lastLoud = now;
      const speaking = now - lastLoud < 250;
      if (speaking !== on) { on = speaking; cb(on); }
    }, 80);
    return () => { clearInterval(timer); try { src.disconnect(); } catch { /* already gone */ } };
  }

  async function arm() {
    const mine = ref(db, `rooms/${v.code}/voice/${v.uid}`);
    await onDisconnect(mine).remove();
    await onDisconnect(ref(db, `rooms/${v.code}/signal/${v.uid}`)).remove();
    await set(mine, { name: v.name, sid: v.sid, muted: v.muted, joined: serverTimestamp() });
  }

  function send(peer, type, data) {
    return set(push(ref(db, `rooms/${v.code}/signal/${peer.uid}`)), {
      from: v.uid, sid: v.sid, toSid: peer.sid, type,
      data: JSON.stringify(data), ts: serverTimestamp(),
    }).catch(err => console.error('voice signal failed:', err.code || err.message));
  }

  async function makeOffer(peer, iceRestart = false) {
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart }));
      await send(peer, 'offer', peer.pc.localDescription.toJSON());
    } catch (err) {
      console.error('offer failed:', err);
    }
  }

  async function flushPending(peer) {
    peer.remoteSet = true;
    const list = peer.pending;
    peer.pending = [];
    for (const c of list) await peer.pc.addIceCandidate(c).catch(err => console.warn('ice:', err.message));
  }

  async function processSignal(m) {
    if (!m || m.from === v.uid || v.status === 'off') return;
    if (m.toSid && m.toSid !== v.sid) return;
    let data;
    try { data = JSON.parse(m.data); } catch { return; }

    let peer = v.peers.get(m.from);
    if (peer && peer.sid !== m.sid) {
      if (m.type !== 'offer') return;
      closePeer(m.from);
      peer = null;
    }

    if (m.type === 'offer') {
      if (!peer) peer = openPeer(m.from, m.sid);
      if (peer.offerer) return;
      await peer.pc.setRemoteDescription(data);
      await flushPending(peer);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      await send(peer, 'answer', peer.pc.localDescription.toJSON());
    } else if (m.type === 'answer') {
      if (!peer || !peer.offerer || peer.pc.signalingState !== 'have-local-offer') return;
      await peer.pc.setRemoteDescription(data);
      await flushPending(peer);
    } else if (m.type === 'ice') {
      if (!peer) return;
      if (peer.remoteSet) await peer.pc.addIceCandidate(data).catch(err => console.warn('ice:', err.message));
      else peer.pending.push(data);
    }
  }

  function handleSignal(key, m) {
    remove(ref(db, `rooms/${v.code}/signal/${v.uid}/${key}`)).catch(() => {});
    v.queue = v.queue.then(() => processSignal(m)).catch(err => console.error('voice signal error:', err));
  }

  function attachRemote(peer, stream) {
    if (peer.audio) return;
    const audio = new Audio();
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.muted = v.deafened;
    audio.play().catch(() => {});
    peer.audio = audio;
    peer.stopMeter = meter(stream, on => setSpeaking(peer.uid, on));
  }

  function openPeer(uid, sid) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = {
      uid, sid, pc,
      offerer: v.uid < uid,
      remoteSet: false, pending: [],
      audio: null, stopMeter: null,
    };
    v.peers.set(uid, peer);

    v.stream.getTracks().forEach(t => pc.addTrack(t, v.stream));
    pc.onicecandidate = e => { if (e.candidate) send(peer, 'ice', e.candidate.toJSON()); };
    pc.ontrack = e => attachRemote(peer, e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && peer.offerer && v.peers.get(uid) === peer) makeOffer(peer, true);
      emit();
    };

    if (peer.offerer) makeOffer(peer);
    return peer;
  }

  function closePeer(uid) {
    const peer = v.peers.get(uid);
    if (!peer) return;
    v.peers.delete(uid);
    if (peer.stopMeter) peer.stopMeter();
    if (peer.audio) { peer.audio.pause(); peer.audio.srcObject = null; }
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    v.speaking.delete(uid);
  }

  function syncRoster(data) {
    const roster = {};
    Object.keys(data).forEach(uid => { if (data[uid] && data[uid].sid) roster[uid] = data[uid]; });
    v.roster = roster;
    for (const [uid, peer] of [...v.peers]) {
      if (!roster[uid] || roster[uid].sid !== peer.sid) closePeer(uid);
    }
    Object.keys(roster).forEach(uid => {
      if (uid !== v.uid && !v.peers.has(uid)) openPeer(uid, roster[uid].sid);
    });
    emit();
  }

  function applyAudio() {
    if (v.stream) v.stream.getAudioTracks().forEach(t => { t.enabled = !v.muted; });
    v.peers.forEach(p => { if (p.audio) p.audio.muted = v.deafened; });
    if (v.status === 'on') {
      set(ref(db, `rooms/${v.code}/voice/${v.uid}/muted`), v.muted).catch(() => {});
    }
    if (v.muted) v.speaking.delete(v.uid);
    emit();
  }

  function toggleMute() {
    if (v.status !== 'on') return;
    if (v.deafened) { v.deafened = false; v.muted = false; }
    else v.muted = !v.muted;
    applyAudio();
  }

  function toggleDeafen() {
    if (v.status !== 'on') return;
    v.deafened = !v.deafened;
    if (v.deafened) { v.mutedBeforeDeafen = v.muted; v.muted = true; }
    else v.muted = v.mutedBeforeDeafen;
    applyAudio();
  }

  async function join(code, uid, name) {
    if (v.status !== 'off') return { error: 'you are already in the call.' };
    if (!auth.currentUser) return { error: 'not signed in.' };
    const token = ++v.token;
    v.status = 'joining';
    emit();

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      console.error(err);
      if (token === v.token) { v.status = 'off'; emit(); }
      if (err.name === 'NotAllowedError') return { error: 'microphone access was blocked.' };
      if (err.name === 'NotFoundError') return { error: 'no microphone found.' };
      return { error: 'could not open the microphone.' };
    }
    if (token !== v.token) { stream.getTracks().forEach(t => t.stop()); return { cancelled: true }; }

    Object.assign(v, {
      code, uid, name, sid: randomId(), stream,
      muted: false, deafened: false, mutedBeforeDeafen: false,
      roster: {}, queue: Promise.resolve(),
    });
    v.stopLocalMeter = meter(stream, on => setSpeaking(uid, on));

    try {
      await remove(ref(db, `rooms/${code}/signal/${uid}`)).catch(() => {});
      v.stops.push(onChildAdded(
        ref(db, `rooms/${code}/signal/${uid}`),
        snap => handleSignal(snap.key, snap.val()),
        err => console.warn('voice inbox stopped:', err.code)
      ));
      await arm();
      let first = true;
      v.stops.push(onValue(ref(db, '.info/connected'), snap => {
        if (first) { first = false; return; }
        if (snap.val() === true && v.status === 'on') arm().catch(err => console.warn('voice re-arm failed:', err.code));
      }));
      v.stops.push(onValue(
        ref(db, `rooms/${code}/voice`),
        snap => syncRoster(snap.val() || {}),
        err => console.warn('voice roster stopped:', err.code)
      ));
      if (token !== v.token) return { cancelled: true };
      v.status = 'on';
      emit();
      return {};
    } catch (err) {
      console.error(err);
      await leave();
      return { error: 'could not join the call: ' + (err.code || err.message) };
    }
  }

  async function leave() {
    if (v.status === 'off') return;
    const { code, uid } = v;
    v.token++;
    v.status = 'off';
    v.stops.forEach(stop => { try { stop(); } catch { /* ignore */ } });
    v.stops = [];
    [...v.peers.keys()].forEach(closePeer);
    if (v.stopLocalMeter) { v.stopLocalMeter(); v.stopLocalMeter = null; }
    if (v.stream) { v.stream.getTracks().forEach(t => t.stop()); v.stream = null; }
    if (v.ctx) { v.ctx.close().catch(() => {}); v.ctx = null; }
    v.roster = {};
    v.speaking.clear();
    v.muted = false;
    v.deafened = false;
    emit();

    if (!code || !uid) return;
    const mine = ref(db, `rooms/${code}/voice/${uid}`);
    const inbox = ref(db, `rooms/${code}/signal/${uid}`);
    onDisconnect(mine).cancel().catch(() => {});
    onDisconnect(inbox).cancel().catch(() => {});
    await remove(mine).catch(() => {});
    await remove(inbox).catch(() => {});
  }

  return {
    join, leave, toggleMute, toggleDeafen,
    rearm: () => { if (v.status === 'on') arm().catch(err => console.warn('voice re-arm failed:', err.code)); },
    get active() { return v.status !== 'off'; },
  };
}
