# Radio Server Service

Standalone Node.js radio backend designed to stream local cached MP3 files through Icecast and expose authenticated control APIs for future bots or apps.

## What it does

- downloads audio with yt-dlp into a local cache
- starts streaming only after the first authenticated play request
- keeps a single FFmpeg streaming process alive for the active session
- feeds FFmpeg with cached MP3 files only
- loops a generated fallback MP3 when the queue is empty
- tracks internal radio states for later bot/dashboard integration
- publishes the stream through Icecast at `/stream`
- exposes authenticated REST endpoints for queue control

## Project layout

```text
radio-server/
├── api/
├── queue/
├── downloader/
├── streamer/
├── songs/
├── middleware/
├── logs/
├── config/
├── utils/
├── server.js
└── .env
```

## WSL Ubuntu setup

1. Install system packages:

```bash
sudo apt update
sudo apt install -y curl gnupg ffmpeg yt-dlp icecast2 nodejs npm
```

2. Configure Icecast:

- edit `/etc/icecast2/icecast.xml`
- set the source password to match `ICECAST_PASSWORD`
- keep the mountpoint available at `/stream`
- keep the public listener port at `8000`

3. Start Icecast:

```bash
sudo systemctl enable icecast2
sudo systemctl restart icecast2
sudo systemctl status icecast2
```

4. Install Node dependencies:

```bash
npm install
```

5. Create `.env` from the example:

```bash
cp .env.example .env
```

6. Fill in `API_TOKEN` and `ICECAST_PASSWORD`.

7. If you want the stream to be reachable from a domain or VPS tunnel, set `PUBLIC_STREAM_URL` to the public listener URL ending in `/stream`.

8. Start the radio server:

```bash
npm start
```

## Local testing

- API health: `http://localhost:3000/health`
- Icecast stream: `http://localhost:8000/stream`
- The stream starts on the first `POST /play` request.

Use an authenticated request to queue audio:

```bash
curl -X POST http://localhost:3000/play \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"query":"lofi hip hop"}'
```

## Public access for testing

Expose the Icecast listener port, not the API port.

Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:8000
```

Ngrok:

```bash
ngrok http 8000
```

The resulting public stream URL will be the tunnel URL plus `/stream`.

If you set `PUBLIC_STREAM_URL`, the API health response will advertise that URL instead of the localhost Icecast address.

For a VPS deployment, keep Icecast mounted at `/stream`, expose port `8000`, and point `PUBLIC_STREAM_URL` at the public endpoint, for example `https://radio.example.com/stream`.

## Deployment notes

The codebase is Linux-friendly and can be deployed on Ubuntu VPS hosts with:

```bash
git clone <repo>
npm install
pm2 start server.js --name radio-server
```

Keep Icecast installed and configured separately on the target machine.

The `musicBot/` directory is intentionally ignored by git so the control bot can stay local while the radio server is versioned and deployed separately.

If you keep a local [musicBot/index.js](musicBot/index.js) alongside the server, the `-promote` whisper command can queue [songs/promotion.mp3](songs/promotion.mp3) as a priority interruption through the authenticated `/promote` API.

## Bot connection guide

See [RADIO_BOT_CONNECTION_INFO.md](RADIO_BOT_CONNECTION_INFO.md) for the external bot/app API contract, auth requirements, listener URL usage, and example integration flow.