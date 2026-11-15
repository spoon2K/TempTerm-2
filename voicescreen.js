import { createGrid } from './ui.js';
import { createVoice } from './voice.js';

export function createVoiceScreen(d) {
  const { $, el } = d;
  const grid = createGrid($('vc-scroll'));
  const rows = new Map();
  let state = { status: 'off', muted: false, deafened: false, people: [] };
  let shown = false;
  let unread = 0;

  const voice = createVoice(s => {
    state = s;
    if (s.status === 'off') {
      if (shown) close();
    } else if (shown) {
      render();
    }
    d.onState(s);
  });

  const sub = el('p', 'vsub dim small');
  const box = el('div', 'vbox');
  const list = el('div', 'vlist');
  const empty = el('p', 'vempty dim small', 'you are the only one in the call. anyone in the room can type /voice to join.');
  box.append(list, empty);
  d.frameEl(box, 'in the call');
  const controls = el('div', 'vctl');
  $('vc-body').append(sub, box, controls);

  function slot() {
    const holder = el('div', 'vitem');
    controls.appendChild(holder);
    return grid.row(holder);
  }

  const micBtn = el('button', 'swrow');
  const micPill = el('span', 'pill');
  micBtn.append(el('span', '', 'Microphone'), micPill);
  grid.add(slot(), micBtn, { key: 'mic', act: () => voice.toggleMute() });

  const soundBtn = el('button', 'swrow');
  const soundPill = el('span', 'pill');
  soundBtn.append(el('span', '', 'Hear everyone'), soundPill);
  grid.add(slot(), soundBtn, { key: 'sound', act: () => voice.toggleDeafen() });

  const backBtn = el('button', 'swrow');
  const backPill = el('span', 'pill yes');
  backPill.hidden = true;
  backBtn.append(el('span', '', 'Back to chat'), backPill);
  grid.add(slot(), backBtn, { key: 'back', act: () => close() });

  const leaveBtn = el('button', 'fbtn danger', 'Leave call');
  grid.add(slot(), leaveBtn, { key: 'leave', act: () => leave() });

  function makeRow(p) {
    const node = el('div', 'vrow');
    const bars = el('span', 'vbars');
    bars.append(el('i'), el('i'), el('i'));
    const pf = el('span', 'pfsq cpf vpf');
    const name = el('span', 'vname');
    const tag = el('span', 'vtag');
    node.append(bars, pf, name, tag);
    d.getUser(p.uid).then(u => d.fillPfp(pf, u));
    return { node, name, tag };
  }

  function tagFor(p) {
    if (p.you) {
      if (state.deafened) return ['deafened', 'bad'];
      if (p.muted) return ['muted', 'bad'];
    } else {
      if (p.link === 'trouble') return ['connection trouble', 'bad'];
      if (p.link === 'connecting') return ['connecting...', 'warn'];
      if (p.muted) return ['muted', 'bad'];
    }
    if (p.speaking) return ['speaking', 'hot'];
    return ['', ''];
  }

  function render() {
    const people = state.people;
    const live = new Set(people.map(p => p.uid));
    rows.forEach((r, uid) => {
      if (!live.has(uid)) {
        r.node.remove();
        rows.delete(uid);
      }
    });

    people.forEach((p, i) => {
      let r = rows.get(p.uid);
      if (!r) {
        r = makeRow(p);
        rows.set(p.uid, r);
      }
      if (list.children[i] !== r.node) list.insertBefore(r.node, list.children[i] || null);
      const [text, kind] = tagFor(p);
      r.node.classList.toggle('speaking', kind === 'hot');
      r.node.classList.toggle('you', p.you);
      r.name.textContent = p.name + (p.you ? ' (you)' : '');
      r.tag.textContent = text;
      r.tag.className = 'vtag' + (kind ? ' ' + kind : '');
    });

    const room = d.getRoom();
    sub.textContent = room ? 'room ' + room.code + ' · ' + room.type : '';
    box.querySelector('.tt2').textContent = 'in the call (' + people.length + ')';
    empty.hidden = !(state.status === 'on' && people.length === 1);

    micPill.textContent = state.muted ? 'MUTED' : 'LIVE';
    micPill.classList.toggle('yes', !state.muted);
    soundPill.textContent = state.deafened ? 'OFF' : 'ON';
    soundPill.classList.toggle('yes', !state.deafened);
    backPill.hidden = unread === 0;
    backPill.textContent = unread + ' new';

    $('vc-msg').textContent = state.status === 'joining' ? 'joining the call...' : '';
  }

  function open() {
    if (!d.getRoom() || !voice.active) return;
    shown = true;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    d.swapScreen('voice');
    render();
    grid.focusKey('mic', false);
  }

  function close() {
    if (!shown) return;
    shown = false;
    unread = 0;
    d.backToChat();
  }

  async function leave() {
    if (!voice.active) return;
    await voice.leave();
    d.announce(d.me.name + ' left the voice call.');
  }

  async function start() {
    const room = d.getRoom();
    if (!room) return;
    if (voice.active) return open();
    const pending = voice.join(room.code, d.me.uid, d.me.name);
    open();
    const res = await pending;
    if (res.cancelled) return;
    if (res.error) return d.say('[system]: ' + res.error);
    d.announce(d.me.name + ' joined the voice call.');
  }

  function bump() {
    if (!shown) return;
    unread++;
    backPill.hidden = false;
    backPill.textContent = unread + ' new';
  }

  d.screens.voice = {
    key: e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'escape' || k === 'tab' || k === 'c' || k === 'f2') { e.preventDefault(); close(); return; }
      if (k === 'm') { e.preventDefault(); voice.toggleMute(); return; }
      if (k === 'd') { e.preventDefault(); voice.toggleDeafen(); return; }
      if (k === 'l') { e.preventDefault(); leave(); return; }
      grid.key(e);
    },
  };

  return { voice, start, open, leave, bump };
}
