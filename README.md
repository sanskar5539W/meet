# Meet + Spotify

A Google Meet–style video meeting app with **real WebRTC video/audio**, chat, participants, screen share — plus a built-in **Spotify** feature:

- The **host** can play music from Spotify for everyone in the meeting.
- **Participants** can search Spotify and request a song. The request (with a direct Spotify link) lands in the host's queue, and the host plays it for the room with one click.

Everyone hears the same track in sync.

---

## Quick start

**Requirements:** [Node.js](https://nodejs.org) 18 or newer.

```bash
# 1. Install dependencies
npm install

# 2. Add your Spotify credentials
cp .env.example .env      # (Windows: copy .env.example .env)
#   then edit .env and paste your Client ID + Client Secret

# 3. Run it
npm start
```

Open **http://127.0.0.1:3000** in your browser.

> Use `127.0.0.1`, not `localhost` — Spotify no longer accepts `http://localhost` as a redirect URL for new apps.

---

## Get your Spotify credentials (free, ~2 minutes)

1. Go to the **[Spotify Developer Dashboard](https://developer.spotify.com/dashboard)** and log in.
2. Click **Create app**. Give it any name/description.
3. In the app settings, add this **Redirect URI** exactly:
   ```
   http://127.0.0.1:3000/callback
   ```
4. Under **APIs used**, tick **Web API** and **Web Playback SDK**, then save.
5. Copy the **Client ID** and **Client Secret** into your `.env` file:
   ```
   SPOTIFY_CLIENT_ID=xxxxxxxxxxxxxxxx
   SPOTIFY_CLIENT_SECRET=xxxxxxxxxxxxxxxx
   ```
6. Restart the server (`npm start`).

Song **search** works with just the Client ID + Secret (no user login).

---

## Using the app

1. On the home page click **New meeting → Start an instant meeting** (you become the host), or paste a code/link to join an existing meeting.
2. Set your name, check your camera/mic, and click **Join now**.
3. In the call, use the bottom bar: mic, camera, present (screen share), raise hand, **Music**, people, and chat.

### The music feature

Open the **Music** button (Spotify icon) in the control bar.

**As the host:**
- Search any song and click **▶ Play** — it starts playing for everyone, synced.
- Participant requests appear under **Requests from participants** with the requester's name and a Spotify link. Click **▶** to play a requested song for the room.
- Use the bottom now-playing bar to pause/resume or stop for everyone.
- *(Optional)* Click **Connect Spotify Premium** to also hear the **full-length** track on your own device via Spotify's Web Playback SDK.

**As a participant:**
- Search a song and click **＋ Request**. The host receives it instantly.
- You'll hear whatever the host is playing, in sync — no login required.

---

## How music is shared (important)

Spotify's full-track audio is DRM-protected and **cannot legally be captured and re-streamed** to other people. So this app shares music the way that's actually allowed:

- **Shared audio = Spotify's official 30-second track previews.** When the host hits play, the server broadcasts a timestamped event and every browser plays the same preview in sync. This needs **no login from anyone** and works for the whole room.
- **Full-length playback** is available to the **host only, on the host's own device**, if they connect Spotify **Premium** (the Web Playback SDK). This is the same limitation behind Spotify's own "Jam" group sessions, where each listener plays through their own Premium account.
- A few tracks don't have a preview from Spotify; those are marked "no preview," and anyone can still open them in the Spotify app via the ↗ link.

---

## Meeting with people on other devices

Browsers only allow camera/mic access over a **secure context**: `https://` or `http://127.0.0.1` / `localhost`.

- **Two tabs on the same computer** → works out of the box at `http://127.0.0.1:3000`.
- **Other devices / over the internet** → serve it over HTTPS. Easiest options:
  - Run a tunnel, e.g. `npx localtunnel --port 3000` or ngrok, and use the HTTPS URL it gives you. Add that URL + `/callback` as a Redirect URI in your Spotify app and set `PUBLIC_URL` in `.env` to match.
  - Or deploy to any Node host (Render, Railway, Fly.io, a VPS). Set the env vars there and point `PUBLIC_URL` at your deployed URL.

WebRTC here uses public STUN servers and a full-mesh topology — great for small calls (roughly up to ~6 people). For larger rooms or restrictive networks you'd add a TURN server and/or an SFU.

---

## Deploy a live HTTPS link (Render)

Want to send people a link instead of everyone running it locally? Deploy to [Render](https://render.com) for free. Because the site is served over HTTPS, camera/mic work for everyone, on any device.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sanskar5539W/meet)

**Steps:**

1. Push this project to GitHub (already done ✔).
2. Click the **Deploy to Render** button above, or go to the [Render dashboard](https://dashboard.render.com) → **New → Blueprint** and pick your `meet` repo. Render reads `render.yaml` automatically.
3. When prompted, enter your two secrets:
   - `SPOTIFY_CLIENT_ID`
   - `SPOTIFY_CLIENT_SECRET`
   (Leave `PUBLIC_URL` blank — the app auto-detects its own URL on Render.)
4. Click **Apply / Create**. Wait for the build to finish. You'll get a URL like `https://meet-spotify-xxxx.onrender.com`.
5. **Add the redirect URI to Spotify:** in your [Spotify app settings](https://developer.spotify.com/dashboard), add
   ```
   https://YOUR-RENDER-URL.onrender.com/callback
   ```
   (use the exact URL Render gave you), and save. This is only needed for the optional host Premium login.
6. Open your Render URL and share it. 🎉

> On Render's free plan the service sleeps after ~15 minutes of inactivity and takes a few seconds to wake on the next visit. Upgrade to a paid instance to keep it always on.

**Prefer Railway?** It also works: create a project from your GitHub repo, and Railway auto-detects the Node app (`npm install` / `npm start`). Add `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and set `PUBLIC_URL` to your Railway URL, then add `<that URL>/callback` to your Spotify app.

## Project structure

```
meet-spotify/
├─ server.js            Express + Socket.IO: signaling, chat, music sync, Spotify search proxy
├─ package.json
├─ render.yaml          One-click Render deploy blueprint
├─ .env.example
└─ public/
   ├─ index.html        Landing / lobby (Google Meet home)
   ├─ room.html         Pre-join device check + in-meeting UI
   ├─ callback.html     Spotify OAuth (PKCE) popup handler
   ├─ css/style.css
   └─ js/
      ├─ app.js         Lobby logic (create/join meeting)
      ├─ room.js        Media, WebRTC mesh, chat, participants, controls
      └─ spotify.js     Search, requests, synced playback, optional Premium SDK
```

## Environment variables

| Variable | Purpose |
|---|---|
| `SPOTIFY_CLIENT_ID` | Your Spotify app Client ID (required for search) |
| `SPOTIFY_CLIENT_SECRET` | Your Spotify app Client Secret (required for search) |
| `PUBLIC_URL` | Base URL browsers use (default `http://127.0.0.1:3000`); used to build the OAuth redirect |
| `PORT` | Port to listen on (default `3000`) |

## Notes

- This is a self-hosted demo/starter, not affiliated with Google or Spotify. "Google Meet" and "Spotify" are trademarks of their owners.
- Search requires valid Spotify credentials; without them, video/chat still work and the music panel shows a setup notice.

## License

MIT
