/* ==========================================================================
   Spotify music module (window.Music)

   Model
   -----
   • SEARCH        : anyone can search via the server proxy (no login needed).
   • REQUEST       : a participant selects a track -> the request (with the
                     Spotify link) is delivered to the HOST's request queue.
   • PLAY FOR ALL  : only the HOST can start playback. The server broadcasts a
                     timestamped "music-sync" event; every client plays the same
                     30-second Spotify preview in sync -> everyone hears it.
   • PREMIUM (opt) : the host may connect Spotify Premium to also hear the
                     FULL track locally via the Web Playback SDK. (Full-track
                     audio is DRM-protected and cannot be re-streamed to others,
                     which is why the *shared* audio uses previews.)
   ========================================================================== */

window.Music = (function () {
  const $ = (id) => document.getElementById(id);

  const state = {
    socket: null,
    isHost: false,
    cfg: { clientId: '', redirectUri: '', configured: false },
    // premium / SDK
    token: null,
    tokenExpiry: 0,
    player: null,
    deviceId: null,
    premium: false,
    sdkReady: false,
    pendingInit: false,
    // playback bookkeeping
    current: null, // current track object
    requests: [],
    reqCount: 0,
    audio: null,
    searchTimer: null,
  };

  /* ----------------------- init (DOM wiring) ------------------------- */
  function init() {
    state.audio = $('previewAudio');
    state.audio.volume = 0.8;

    fetch('/api/spotify/config')
      .then((r) => r.json())
      .then((cfg) => {
        state.cfg = cfg;
        if (!cfg.configured) {
          const w = $('spWarn');
          w.classList.remove('hidden');
          w.innerHTML =
            'Spotify search is not configured on the server. Add <code>SPOTIFY_CLIENT_ID</code> and ' +
            '<code>SPOTIFY_CLIENT_SECRET</code> to your <code>.env</code> file and restart to enable music.';
        }
      })
      .catch(() => {});

    // search (debounced)
    const input = $('spSearchInput');
    input.addEventListener('input', () => {
      clearTimeout(state.searchTimer);
      const q = input.value.trim();
      if (!q) { $('spResults').innerHTML = ''; $('spStatus').textContent = 'Search for a track to get started.'; return; }
      state.searchTimer = setTimeout(() => search(q), 350);
    });

    // now-playing controls (host)
    $('npPlayPause').addEventListener('click', togglePlayPause);
    $('npStop').addEventListener('click', stopForEveryone);

    // preview audio -> progress bar + broadcast end
    state.audio.addEventListener('timeupdate', () => {
      if (!state.current) return;
      const dur = state.audio.duration || 30;
      const pct = Math.min(100, (state.audio.currentTime / dur) * 100);
      $('npProgress').style.width = pct + '%';
    });

    // Premium login (optional)
    $('spLoginBtn').addEventListener('click', login);
    window.addEventListener('message', onAuthMessage);
  }

  /* ----------------------- socket wiring ----------------------------- */
  function attach(socket) {
    state.socket = socket;
  }

  function setRole(isHost) {
    state.isHost = isHost;
    $('spRole').textContent = isHost ? 'Host' : 'Guest';
    $('spRole').className = 'role-tag ' + (isHost ? 'host' : 'guest');
    $('spHostLogin').classList.add('hidden'); // Full-track sharing isn't possible (Spotify DRM); everyone uses the synced preview.
    $('spRequestsWrap').classList.toggle('hidden', !isHost);
    $('npControls').style.display = isHost ? 'flex' : 'none';
    // re-render current results so Play/Request buttons match role
    if (state._lastResults) renderResults(state._lastResults);
  }

  /* ----------------------- search ------------------------------------ */
  async function search(q) {
    $('spStatus').innerHTML = '<span class="spin"></span> Searching…';
    $('spResults').innerHTML = '';
    try {
      const r = await fetch('/api/spotify/search?q=' + encodeURIComponent(q));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Search failed');
      state._lastResults = data.tracks || [];
      if (!state._lastResults.length) { $('spStatus').textContent = 'No results.'; return; }
      $('spStatus').textContent = '';
      renderResults(state._lastResults);
    } catch (e) {
      $('spStatus').textContent = 'Search unavailable. Check the server Spotify credentials.';
    }
  }

  function renderResults(tracks) {
    const wrap = $('spResults');
    wrap.innerHTML = '';
    tracks.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'track';
      const noPreview = !t.previewUrl;
      const action = state.isHost
        ? `<button class="pill-btn play" ${noPreview ? 'title="No preview — shared audio unavailable"' : ''}>▶ Play</button>`
        : `<button class="pill-btn request">＋ Request</button>`;
      row.innerHTML = `
        <img src="${t.image || ''}" alt="" onerror="this.style.visibility='hidden'"/>
        <div class="t-meta">
          <div class="t-name">${esc(t.name)}</div>
          <div class="t-artist">${esc(t.artists)}${noPreview ? ' · <span style="color:#b06000">no preview</span>' : ''}</div>
        </div>
        <div class="t-actions">
          ${action}
          <a class="pill-btn ghost" href="${t.externalUrl}" target="_blank" rel="noopener" title="Open in Spotify">↗</a>
        </div>`;
      const btn = row.querySelector('.play, .request');
      btn.addEventListener('click', () => {
        if (state.isHost) playForEveryone(t);
        else requestSong(t);
      });
      wrap.appendChild(row);
    });
  }

  /* ----------------------- participant: request --------------------- */
  function requestSong(track) {
    state.socket?.emit('song-request', { track });
    MeetApp.toast(`Requested "${track.name}" — sent to the host`);
  }

  /* ----------------------- host: receive request -------------------- */
  function onRequest(r) {
    state.requests.unshift(r);
    renderRequests();
    state.reqCount++;
    if (document.querySelector('#view-spotify').style.display !== 'flex') {
      MeetApp.setBadge('music', state.reqCount);
    }
    MeetApp.toast(`${r.requestedBy} requested "${r.track.name}"`);
  }

  function renderRequests() {
    const wrap = $('spRequests');
    wrap.innerHTML = '';
    if (!state.requests.length) {
      wrap.innerHTML = '<div class="sp-status">No requests yet.</div>';
      return;
    }
    state.requests.forEach((r) => {
      const t = r.track;
      const row = document.createElement('div');
      row.className = 'req-row';
      row.innerHTML = `
        <img src="${t.image || ''}" alt="" onerror="this.style.visibility='hidden'"/>
        <div class="r-meta">
          <div class="r-name">${esc(t.name)} — ${esc(t.artists)}</div>
          <div class="r-by">Requested by ${esc(r.requestedBy)}</div>
          <a class="r-link" href="${t.externalUrl}" target="_blank" rel="noopener">${t.externalUrl}</a>
        </div>
        <button class="pill-btn play" ${t.previewUrl ? '' : 'title="No preview"'}>▶</button>`;
      row.querySelector('.play').addEventListener('click', () => playForEveryone(t));
      wrap.appendChild(row);
    });
  }

  /* ----------------------- host: play for everyone ------------------ */
  async function playForEveryone(track) {
    if (!state.isHost) return;
    // The Web API no longer returns preview_url, so recover one from the embed.
    if (!track.previewUrl && track.id) {
      try {
        const r = await fetch('/api/spotify/preview' + '?' + 'id' + '=' + encodeURIComponent(track.id));
        const d = await r.json();
        if (d && d.previewUrl) track = Object.assign({}, track, { previewUrl: d.previewUrl });
      } catch (e) {}
    }
    if (!track.previewUrl && !state.premium) {
      MeetApp.toast('No preview available for this track. Open it in Spotify, or connect Premium for full playback.');
    }
    state.socket?.emit('music-control', { action: 'play', track, positionMs: 0 });
    openMusicPanelIfClosed();
  }

  function togglePlayPause() {
    if (!state.isHost || !state.current) return;
    const playing = !state.audio.paused || state._premiumPlaying;
    if (playing) {
      const posMs = Math.floor((state.audio.currentTime || 0) * 1000);
      state.socket?.emit('music-control', { action: 'pause', track: state.current, positionMs: posMs });
      if (state.premium) safePremium('pause');
    } else {
      const posMs = Math.floor((state.audio.currentTime || 0) * 1000);
      state.socket?.emit('music-control', { action: 'play', track: state.current, positionMs: posMs });
      if (state.premium) safePremium('resume');
    }
  }

  function stopForEveryone() {
    if (!state.isHost) return;
    state.socket?.emit('music-control', { action: 'stop' });
    if (state.premium) safePremium('pause');
  }

  /* ----------------------- everyone: apply sync --------------------- */
  function applyInitialMusic(m) {
    if (!m || !m.track) return;
    state.current = m.track;
    showNowPlaying(m.track);
    if (m.isPlaying) {
      const elapsed = Date.now() - (m.updatedAt || Date.now());
      applySync({ action: 'play', track: m.track, positionMs: (m.positionMs || 0) + elapsed, serverTime: Date.now() });
    }
  }

  function applySync({ action, track, positionMs = 0, serverTime }) {
    if (action === 'stop') { hideNowPlaying(); return; }

    if (track) { state.current = track; showNowPlaying(track); }

    // Premium host hears the full track via SDK; skip the shared preview locally.
    const usePremiumLocal = false; // Everyone plays the synced preview so non-Premium participants stay in sync with the host.

    if (action === 'play') {
      setPlayPauseIcon(true);
      if (usePremiumLocal) { state._premiumPlaying = true; return; }
      const prev = state.current && state.current.previewUrl;
      if (!prev) return; // nothing shareable to play
      if (state.audio.src !== prev) state.audio.src = prev;
      const latency = Math.max(0, Date.now() - (serverTime || Date.now()));
      const target = (positionMs + latency) / 1000;
      const seekAndPlay = () => {
        try { state.audio.currentTime = Math.min(target, (state.audio.duration || 30) - 0.1); } catch (_) {}
        state.audio.play().catch(() => promptAudioGesture());
      };
      if (state.audio.readyState >= 1) seekAndPlay();
      else state.audio.addEventListener('loadedmetadata', seekAndPlay, { once: true });
    } else if (action === 'pause') {
      setPlayPauseIcon(false);
      state._premiumPlaying = false;
      if (usePremiumLocal) return;
      state.audio.pause();
      if (positionMs) { try { state.audio.currentTime = positionMs / 1000; } catch (_) {} }
    } else if (action === 'seek') {
      try { state.audio.currentTime = positionMs / 1000; } catch (_) {}
    }
  }

  function promptAudioGesture() {
    MeetApp.toast('Tap anywhere to enable meeting music audio');
    const resume = () => { state.audio.play().catch(() => {}); window.removeEventListener('click', resume); };
    window.addEventListener('click', resume, { once: true });
  }

  /* ----------------------- now-playing UI --------------------------- */
  function showNowPlaying(t) {
    $('npBar').classList.add('show');
    $('npImg').src = t.image || '';
    $('npName').textContent = t.name;
    $('npArtist').textContent = t.artists;
    const pill = $('npPill');
    pill.classList.add('show');
    $('npPillImg').src = t.image || '';
    $('npPillText').textContent = `${t.name} — ${t.artists}`;
  }
  function hideNowPlaying() {
    state.current = null;
    state._premiumPlaying = false;
    state.audio.pause();
    state.audio.removeAttribute('src');
    $('npBar').classList.remove('show');
    $('npPill').classList.remove('show');
    $('npProgress').style.width = '0%';
  }
  function setPlayPauseIcon(playing) {
    $('npPlayPause').innerHTML = playing
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  }
  function openMusicPanelIfClosed() {
    if (document.querySelector('#view-spotify').style.display !== 'flex') MeetApp.openPanel('spotify');
  }

  /* ----------------------- Premium / PKCE / SDK --------------------- */
  function b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randStr(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    return Array.from(crypto.getRandomValues(new Uint8Array(len))).map((x) => chars[x % chars.length]).join('');
  }
  async function login() {
    if (!state.cfg.clientId) { MeetApp.toast('Spotify not configured on the server.'); return; }
    const verifier = randStr(64);
    localStorage.setItem('sp_verifier', verifier);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const scope = 'streaming user-read-email user-read-private user-modify-playback-state';
    const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: state.cfg.clientId,
      response_type: 'code',
      redirect_uri: state.cfg.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope,
    });
    window.open(url, 'spotify-login', 'width=480,height=760');
  }
  function onAuthMessage(e) {
    if (e.origin !== location.origin) return;
    if (e.data?.type !== 'spotify-token') return;
    if (e.data.error) { MeetApp.toast('Spotify login failed: ' + e.data.error); return; }
    state.token = e.data.access_token;
    state.tokenExpiry = Date.now() + (e.data.expires_in || 3600) * 1000;
    if (state.sdkReady) initPlayer();
    else state.pendingInit = true;
  }
  function initPlayer() {
    if (!window.Spotify || !state.token || state.player) return;
    const player = new window.Spotify.Player({
      name: 'Meet Music (Host)',
      getOAuthToken: (cb) => cb(state.token),
      volume: 0.6,
    });
    player.addListener('ready', ({ device_id }) => {
      state.deviceId = device_id;
      state.premium = true;
      $('spHostLogin').classList.add('hidden');
      $('spHostConnected').classList.remove('hidden');
      MeetApp.toast('Spotify Premium connected — full-track playback enabled');
    });
    player.addListener('account_error', () => MeetApp.toast('Spotify Premium is required for full-track playback.'));
    player.addListener('authentication_error', () => MeetApp.toast('Spotify authentication error — please reconnect.'));
    player.addListener('initialization_error', (e) => console.warn('Spotify SDK init error', e));
    player.connect();
    state.player = player;
  }
  function playFullTrackOnHost(uri) {
    fetch('https://api.spotify.com/v1/me/player/play?device_id=' + state.deviceId, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [uri] }),
    }).then((r) => { if (!r.ok && r.status !== 204) console.warn('play failed', r.status); state._premiumPlaying = true; });
  }
  function safePremium(method) {
    try { state.player && state.player[method] && state.player[method](); } catch (_) {}
  }

  // SDK global ready hook
  window.onSpotifyWebPlaybackSDKReady = () => {
    state.sdkReady = true;
    if (state.pendingInit) initPlayer();
  };

  /* ----------------------- util -------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // wire up once DOM is ready
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);

  return { attach, setRole, applyInitialMusic, applySync, onRequest };
})();
