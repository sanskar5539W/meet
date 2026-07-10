/* ==========================================================================
   Meeting room controller — media, WebRTC mesh, chat, participants, controls
   ========================================================================== */

const roomId = decodeURIComponent((location.pathname.split('/room/')[1] || '').split(/[?#]/)[0]);
const urlParams = new URLSearchParams(location.search);

const MeetApp = (window.MeetApp = {
  roomId,
  socket: null,
  selfId: null,
  isHost: false,
  selfName: '',
  toast,
  openPanel,
});

/* ---------------------------- helpers ---------------------------------- */
function $(id) { return document.getElementById(id); }
function initials(name) {
  return (name || 'G').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'G';
}
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ---------------------------- pre-join --------------------------------- */
let localStream = null;
let screenStream = null;
let micOn = true;
let camOn = true;

const previewVideo = $('previewVideo');
const previewCamOff = $('previewCamOff');
const nameInput = $('nameInput');

nameInput.value = localStorage.getItem('meet_name') || '';
$('previewAvatar').textContent = initials(nameInput.value || 'You');
nameInput.addEventListener('input', () => {
  $('previewAvatar').textContent = initials(nameInput.value || 'You');
});

async function initPreview() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    previewVideo.srcObject = localStream;
  } catch (e) {
    console.warn('getUserMedia failed:', e);
    camOn = false; micOn = false;
    localStream = new MediaStream(); // empty stream — join audio/video-less
    reflectPrejoinToggles();
    toast('Could not access camera/mic. You can still join.');
  }
}
function reflectPrejoinToggles() {
  $('pjMic').classList.toggle('off', !micOn);
  $('pjCam').classList.toggle('off', !camOn);
  previewCamOff.classList.toggle('hidden', camOn);
  if (localStream) {
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  }
}
$('pjMic').addEventListener('click', () => { micOn = !micOn; reflectPrejoinToggles(); });
$('pjCam').addEventListener('click', () => { camOn = !camOn; reflectPrejoinToggles(); });

$('roomMeta').textContent = roomId;
initPreview();

/* ---------------------------- join ------------------------------------- */
$('joinNowBtn').addEventListener('click', joinNow);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinNow(); });

function joinNow() {
  MeetApp.selfName = (nameInput.value || 'You').trim().slice(0, 40);
  localStorage.setItem('meet_name', MeetApp.selfName);

  $('prejoin').classList.add('hidden');
  $('room').classList.remove('hidden');

  $('ctrlCode').textContent = roomId;
  updateClock();
  setInterval(updateClock, 10000);

  reflectPrejoinToggles();
  addTile(MeetApp.selfId || 'self', MeetApp.selfName, true, localStream);
  reflectControlButtons();

  connectSocket();
}

function updateClock() {
  const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('ctrlTime').textContent = t;
}

/* ---------------------------- Socket + WebRTC -------------------------- */
let RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};
// Load STUN/TURN servers from the server so calls connect across networks.
fetch('/api/turn')
  .then((r) => r.json())
  .then((d) => { if (d && Array.isArray(d.iceServers) && d.iceServers.length) RTC_CONFIG = { iceServers: d.iceServers }; })
  .catch(() => {});
const peers = new Map();       // socketId -> RTCPeerConnection
const remoteNames = new Map(); // socketId -> name

function connectSocket() {
  const socket = io();
  MeetApp.socket = socket;

  socket.on('connect', () => {
    socket.emit('join', { roomId, name: MeetApp.selfName });
  });

  socket.on('joined', ({ selfId, isHost, existing, music }) => {
    MeetApp.selfId = selfId;
    MeetApp.isHost = isHost;
    // rename the self tile id now that we know our socket id
    renameSelfTile(selfId);

    if (window.Music) {
      Music.attach(socket);
      Music.setRole(isHost);
      if (music) Music.applyInitialMusic(music);
    }

    // We initiate an offer to everyone already in the room.
    existing.forEach((p) => {
      remoteNames.set(p.id, p.name);
      createPeer(p.id, true);
    });
  });

  socket.on('user-joined', ({ id, name }) => {
    remoteNames.set(id, name);
    // The newcomer initiates to us; we just wait for their offer.
  });

  socket.on('signal', async ({ from, data }) => {
    let pc = peers.get(from);
    if (!pc) pc = createPeer(from, false);
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { to: from, data: pc.localDescription });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } else if (data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data));
      }
    } catch (err) {
      console.error('signal error', err);
    }
  });

  socket.on('user-left', ({ id }) => {
    const pc = peers.get(id);
    if (pc) pc.close();
    peers.delete(id);
    removeTile(id);
    remoteNames.delete(id);
  });

  socket.on('participants', ({ hostId, participants }) => {
    renderPeople(hostId, participants);
    participants.forEach((p) => {
      remoteNames.set(p.id, p.name);
      updateTileState(p.id === MeetApp.selfId ? (MeetApp.selfId || 'self') : p.id, p);
    });
    if (window.Music) Music.setRole(hostId === MeetApp.selfId);
    MeetApp.isHost = hostId === MeetApp.selfId;
  });

  socket.on('you-are-host', () => {
    MeetApp.isHost = true;
    if (window.Music) Music.setRole(true);
    toast('You are now the meeting host');
  });

  socket.on('chat-message', (m) => addChatMessage(m));
  socket.on('song-request', (r) => window.Music && Music.onRequest(r));
  socket.on('music-sync', (s) => window.Music && Music.applySync(s));

  window.addEventListener('beforeunload', () => socket.emit('leave'));
}

function createPeer(id, initiator) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers.set(id, pc);

  // send our media
  const localTracks = localStream ? localStream.getTracks() : [];
  localTracks.forEach((t) => pc.addTrack(t, localStream));
  // If we joined without camera/mic, still negotiate so we can RECEIVE others.
  if (initiator && localTracks.length === 0) {
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) MeetApp.socket.emit('signal', { to: id, data: e.candidate });
  };
  pc.ontrack = (e) => {
    const [remoteStream] = e.streams;
    ensureRemoteTile(id, remoteStream);
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      // let 'user-left' handle removal
    }
  };

  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        MeetApp.socket.emit('signal', { to: id, data: pc.localDescription });
      } catch (err) { console.error(err); }
    };
  }
  return pc;
}

/* ---------------------------- Video tiles ------------------------------ */
const grid = $('videoGrid');
const tiles = new Map(); // id -> element

function addTile(id, name, isSelf, stream) {
  if (tiles.has(id)) return tiles.get(id);
  const el = document.createElement('div');
  el.className = 'tile' + (isSelf ? ' self' : '');
  el.dataset.id = id;
  el.innerHTML = `
    <video autoplay playsinline ${isSelf ? 'muted' : ''}></video>
    <div class="avatar-lg" style="display:none">${initials(name)}</div>
    <div class="hand">✋</div>
    <div class="badge-mute"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg></div>
    <div class="name-tag"><span class="nt-name">${escapeHtml(name)}</span></div>`;
  grid.appendChild(el);
  tiles.set(id, el);
  const video = el.querySelector('video');
  if (stream) video.srcObject = stream;
  reflowGrid();
  return el;
}
function ensureRemoteTile(id, stream) {
  const el = addTile(id, remoteNames.get(id) || 'Guest', false, null);
  const video = el.querySelector('video');
  if (video.srcObject !== stream) video.srcObject = stream;
}
function renameSelfTile(newId) {
  const el = tiles.get('self') || tiles.get(MeetApp.selfId);
  if (el && newId) {
    tiles.delete('self');
    el.dataset.id = newId;
    tiles.set(newId, el);
  }
}
function removeTile(id) {
  const el = tiles.get(id);
  if (el) { el.remove(); tiles.delete(id); reflowGrid(); }
}
function updateTileState(id, p) {
  const el = tiles.get(id);
  if (!el) return;
  el.classList.toggle('muted', !!p.muted);
  el.classList.toggle('hand-up', !!p.handRaised);
  const isSelf = id === (MeetApp.selfId || 'self') || id === MeetApp.selfId;
  const avatar = el.querySelector('.avatar-lg');
  const video = el.querySelector('video');
  const off = isSelf ? !camOn : !!p.videoOff;
  avatar.style.display = off ? 'grid' : 'none';
  video.style.display = off ? 'none' : 'block';
  const nt = el.querySelector('.nt-name');
  if (nt && p.name) nt.textContent = p.name + (isSelf ? ' (You)' : '');
}
function reflowGrid() {
  grid.dataset.count = Math.min(tiles.size, 12);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------- Control bar ------------------------------ */
function reflectControlButtons() {
  $('btnMic').classList.toggle('danger-on', !micOn);
  $('btnCam').classList.toggle('danger-on', !camOn);
}
$('btnMic').addEventListener('click', () => {
  micOn = !micOn;
  if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  reflectControlButtons();
  MeetApp.socket?.emit('update-state', { muted: !micOn });
});
$('btnCam').addEventListener('click', () => {
  camOn = !camOn;
  if (localStream) localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  reflectControlButtons();
  updateTileState(MeetApp.selfId || 'self', { videoOff: !camOn });
  MeetApp.socket?.emit('update-state', { videoOff: !camOn });
});

// Raise hand
let handUp = false;
$('btnHand').addEventListener('click', () => {
  handUp = !handUp;
  $('btnHand').classList.toggle('active-on', handUp);
  updateTileState(MeetApp.selfId || 'self', { handRaised: handUp });
  MeetApp.socket?.emit('update-state', { handRaised: handUp });
});

// Present (screen share)
$('btnPresent').addEventListener('click', togglePresent);
async function togglePresent() {
  if (screenStream) { stopPresent(); return; }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = screenStream.getVideoTracks()[0];
    // replace outgoing video track in all peer connections
    peers.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(screenTrack);
    });
    // show locally
    const selfTile = tiles.get(MeetApp.selfId) || tiles.get('self');
    if (selfTile) selfTile.querySelector('video').srcObject = screenStream;
    $('btnPresent').classList.add('active-on');
    screenTrack.onended = stopPresent;
    toast('You are presenting to everyone');
  } catch (e) { /* user cancelled */ }
}
function stopPresent() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  const camTrack = localStream && localStream.getVideoTracks()[0];
  peers.forEach((pc) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender && camTrack) sender.replaceTrack(camTrack);
  });
  const selfTile = tiles.get(MeetApp.selfId) || tiles.get('self');
  if (selfTile) selfTile.querySelector('video').srcObject = localStream;
  $('btnPresent').classList.remove('active-on');
}

// Leave
$('btnLeave').addEventListener('click', () => {
  MeetApp.socket?.emit('leave');
  peers.forEach((pc) => pc.close());
  localStream?.getTracks().forEach((t) => t.stop());
  screenStream?.getTracks().forEach((t) => t.stop());
  location.href = '/';
});

/* ---------------------------- Side panels ------------------------------ */
let currentPanel = null;
function openPanel(view) {
  const panel = $('sidePanel');
  if (currentPanel === view) { closePanel(); return; }
  currentPanel = view;
  panel.classList.add('open');
  ['chat', 'people', 'spotify'].forEach((v) => {
    $('view-' + v).style.display = v === view ? 'flex' : 'none';
  });
  if (view === 'chat') { setBadge('chat', 0); $('chatInput').focus(); }
  if (view === 'spotify') { setBadge('music', 0); $('spSearchInput').focus(); }
}
function closePanel() {
  currentPanel = null;
  $('sidePanel').classList.remove('open');
}
document.querySelectorAll('[data-close-panel]').forEach((b) => b.addEventListener('click', closePanel));
$('btnChat').addEventListener('click', () => openPanel('chat'));
$('btnPeople').addEventListener('click', () => openPanel('people'));
$('btnMusic').addEventListener('click', () => openPanel('spotify'));

function setBadge(which, count) {
  const el = which === 'chat' ? $('chatBadge') : $('musicBadge');
  if (count > 0) { el.textContent = count; el.classList.add('show'); }
  else el.classList.remove('show');
}
MeetApp.setBadge = setBadge;

/* ---------------------------- Chat ------------------------------------- */
function sendChat() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  MeetApp.socket?.emit('chat-message', { text });
  input.value = '';
}
$('chatSend').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

let chatUnread = 0;
function addChatMessage(m) {
  const body = $('chatBody');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const time = new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const who = m.fromId === MeetApp.selfId ? 'You' : m.from;
  div.innerHTML = `<div><span class="who">${escapeHtml(who)}</span><span class="when">${time}</span></div>
                   <div class="text">${escapeHtml(m.text)}</div>`;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  if (currentPanel !== 'chat') { chatUnread++; setBadge('chat', chatUnread); }
  else chatUnread = 0;
}

/* ---------------------------- People ----------------------------------- */
function renderPeople(hostId, participants) {
  const body = $('peopleBody');
  body.innerHTML = '';
  participants.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'p-row';
    const you = p.id === MeetApp.selfId ? ' (You)' : '';
    row.innerHTML = `
      <div class="avatar-sm">${initials(p.name)}</div>
      <div class="p-name">${escapeHtml(p.name)}${you}</div>
      ${p.id === hostId ? '<span class="p-host">Host</span>' : ''}
      <div class="p-icons">
        ${p.handRaised ? '<span title="Hand raised">✋</span>' : ''}
        ${p.muted
          ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="#5f6368"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>'
          : '<svg width="18" height="18" viewBox="0 0 24 24" fill="#5f6368"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>'}
      </div>`;
    body.appendChild(row);
  });
  document.querySelector('#view-people .panel-head span').textContent = `People (${participants.length})`;
}
