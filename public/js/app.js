/* Lobby / landing page logic */

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

// Live clock in the nav, Google-style ("10:30 AM · Fri, Jul 10")
function updateClock() {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  document.getElementById('navTime').textContent = `${time} · ${date}`;
}
updateClock();
setInterval(updateClock, 10000);

// Generate a Google-Meet-style code: xxx-xxxx-xxx
function generateCode() {
  const chars = 'abcdefghijkmnopqrstuvwxyz';
  const pick = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

// Extract a room code from raw input or a pasted meeting link
function parseCode(raw) {
  raw = raw.trim();
  if (!raw) return '';
  try {
    if (raw.includes('/room/')) return raw.split('/room/')[1].split(/[?#]/)[0];
    if (raw.startsWith('http')) {
      const u = new URL(raw);
      return u.pathname.replace('/room/', '').replace(/^\//, '');
    }
  } catch (_) {}
  return raw.replace(/\s+/g, '');
}

// ---- New meeting menu ----
const newBtn = document.getElementById('newMeetingBtn');
const menu = document.getElementById('newMeetingMenu');

newBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  menu.classList.toggle('hidden');
});
document.addEventListener('click', () => menu.classList.add('hidden'));

function startMeeting(code) {
  location.href = `/room/${code}?host=1`;
}
document.getElementById('instantMeeting').addEventListener('click', () => startMeeting(generateCode()));
document.getElementById('scheduleMeeting').addEventListener('click', () => {
  const code = generateCode();
  const link = `${location.origin}/room/${code}`;
  navigator.clipboard?.writeText(link).catch(() => {});
  toast('Meeting link copied to clipboard: ' + code);
});

// ---- Join with code ----
const codeInput = document.getElementById('codeInput');
const joinBtn = document.getElementById('joinBtn');

codeInput.addEventListener('input', () => {
  joinBtn.disabled = parseCode(codeInput.value).length < 3;
});
function doJoin() {
  const code = parseCode(codeInput.value);
  if (code.length < 3) return;
  location.href = `/room/${code}`;
}
joinBtn.addEventListener('click', doJoin);
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
