/**
 * Meet + Spotify — backend server
 *
 * Responsibilities:
 *   1. Serve the static front-end (lobby + meeting room).
 *   2. Act as a WebRTC signalling server over Socket.IO (mesh topology).
 *   3. Relay chat, participant state, and synchronized Spotify playback.
 *   4. Proxy Spotify Search using an app-level (Client Credentials) token so
 *      participants can search without logging in, while keeping the client
 *      secret on the server.
 *   5. Expose the public Spotify Client ID + redirect URI so the HOST can log
 *      in via PKCE (needed for full-track Web Playback SDK playback / Premium).
 */

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
// PUBLIC_URL is used to build the Spotify OAuth redirect. In production on
// Render, RENDER_EXTERNAL_URL is provided automatically, so no manual config
// is needed; locally we fall back to 127.0.0.1.
const PUBLIC_URL =
  process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const REDIRECT_URI = `${PUBLIC_URL}/callback`;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*  Spotify — app-level token (Client Credentials) for Search proxy    */
/* ------------------------------------------------------------------ */

let appToken = null;
let appTokenExpiry = 0;

async function getAppToken() {
  if (appToken && Date.now() < appTokenExpiry - 5000) return appToken;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('Spotify credentials missing. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env');
  }
  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Spotify token request failed (${res.status}): ${t}`);
  }
  const data = await res.json();
  appToken = data.access_token;
  appTokenExpiry = Date.now() + data.expires_in * 1000;
  return appToken;
}

// Public config the browser needs for the host PKCE login flow.
app.get('/api/spotify/config', (req, res) => {
  res.json({
    clientId: SPOTIFY_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    configured: Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET),
  });
});

// Search proxy — participants & host use this. No user login required.
app.get('/api/spotify/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ tracks: [] });
  try {
    const token = await getAppToken();
    const url =
      'https://api.spotify.com/v1/search?type=track&market=US&limit=10&q=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: t });
    }
    const data = await r.json();
    const tracks = (data.tracks?.items || []).map((t) => ({
      id: t.id,
      uri: t.uri,
      name: t.name,
      artists: t.artists.map((a) => a.name).join(', '),
      album: t.album?.name || '',
      image: t.album?.images?.[t.album.images.length - 1]?.url || '',
      durationMs: t.duration_ms,
      previewUrl: t.preview_url, // 30s mp3, may be null for some tracks
      externalUrl: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
    }));
    res.json({ tracks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/room/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));
// Spotify redirects the host's browser back here after login.
app.get('/callback', (req, res) => res.sendFile(path.join(__dirname, 'public', 'callback.html')));

/* ------------------------------------------------------------------ */
/*  Real-time meeting layer (Socket.IO)                                */
/* ------------------------------------------------------------------ */

/** rooms: Map<roomId, { host: socketId|null, participants: Map<socketId, info>, music }> */
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { host: null, participants: new Map(), music: null });
  }
  return rooms.get(roomId);
}

function participantList(room) {
  return [...room.participants.entries()].map(([id, info]) => ({ id, ...info }));
}

function broadcastParticipants(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('participants', {
    hostId: room.host,
    participants: participantList(room),
  });
}

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('join', ({ roomId, name }) => {
    if (!roomId) return;
    joinedRoom = roomId;
    const room = getRoom(roomId);

    // First person in the room becomes the host.
    const isHost = room.participants.size === 0 || !room.host;
    if (isHost) room.host = socket.id;

    room.participants.set(socket.id, {
      name: name || 'Guest',
      isHost,
      muted: false,
      videoOff: false,
      handRaised: false,
    });

    socket.join(roomId);

    // Tell the newcomer who is already here (they will initiate WebRTC offers).
    const others = participantList(room).filter((p) => p.id !== socket.id);
    socket.emit('joined', {
      selfId: socket.id,
      hostId: room.host,
      isHost,
      existing: others,
      music: room.music, // current playback so late joiners sync up
    });

    // Tell everyone else a new peer arrived.
    socket.to(roomId).emit('user-joined', { id: socket.id, name: name || 'Guest' });
    broadcastParticipants(roomId);
  });

  /* -------- WebRTC signalling relay (offer / answer / ICE) -------- */
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  /* -------- Participant state (mute / video / raise hand) --------- */
  socket.on('update-state', (patch) => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const info = room.participants.get(socket.id);
    if (!info) return;
    Object.assign(info, patch);
    broadcastParticipants(joinedRoom);
  });

  /* -------- Chat --------------------------------------------------- */
  socket.on('chat-message', ({ text }) => {
    if (!joinedRoom || !text) return;
    const room = rooms.get(joinedRoom);
    const info = room?.participants.get(socket.id);
    io.to(joinedRoom).emit('chat-message', {
      from: info?.name || 'Guest',
      fromId: socket.id,
      text: String(text).slice(0, 2000),
      ts: Date.now(),
    });
  });

  /* -------- Spotify: participant requests a song ------------------ */
  socket.on('song-request', ({ track }) => {
    if (!joinedRoom || !track) return;
    const room = rooms.get(joinedRoom);
    if (!room || !room.host) return;
    const info = room.participants.get(socket.id);
    // Deliver the request (with link) straight to the host.
    io.to(room.host).emit('song-request', {
      track,
      requestedBy: info?.name || 'Guest',
      requestedById: socket.id,
      ts: Date.now(),
    });
  });

  /* -------- Spotify: host controls playback for everyone ---------- */
  socket.on('music-control', (payload) => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || room.host !== socket.id) return; // only host controls
    const { action, track, positionMs = 0 } = payload || {};
    const serverTime = Date.now();

    if (action === 'play') {
      room.music = { track, isPlaying: true, positionMs, updatedAt: serverTime };
    } else if (action === 'pause') {
      room.music = { ...(room.music || {}), isPlaying: false, positionMs, updatedAt: serverTime };
    } else if (action === 'seek') {
      room.music = { ...(room.music || {}), positionMs, updatedAt: serverTime };
    } else if (action === 'stop') {
      room.music = null;
    }
    io.to(joinedRoom).emit('music-sync', { action, track, positionMs, serverTime });
  });

  /* -------- Disconnect / leave ------------------------------------ */
  function leave() {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    room.participants.delete(socket.id);
    socket.to(joinedRoom).emit('user-left', { id: socket.id });

    // If the host left, promote the next participant.
    if (room.host === socket.id) {
      const next = room.participants.keys().next().value || null;
      room.host = next;
      if (next) {
        const info = room.participants.get(next);
        if (info) info.isHost = true;
        io.to(next).emit('you-are-host');
      }
    }
    if (room.participants.size === 0) {
      rooms.delete(joinedRoom);
    } else {
      broadcastParticipants(joinedRoom);
    }
    joinedRoom = null;
  }

  socket.on('leave', leave);
  socket.on('disconnect', leave);
});

server.listen(PORT, () => {
  console.log(`\n  Meet + Spotify running`);
  console.log(`  →  ${PUBLIC_URL}`);
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.log('\n  ⚠  Spotify not configured. Copy .env.example to .env and add your');
    console.log('     SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET to enable music search.\n');
  }
});
