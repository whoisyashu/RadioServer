# Radio Bot Connection Info

This file explains how an external bot or app connects to the radio server.

The radio server is not a bot.
The radio server is the playback backend only.

## What the bot does

The bot is responsible for:

- receiving user commands
- validating permissions
- applying cooldowns
- checking moderation rules
- calling the radio server API
- showing the response to users

The radio server is responsible for:

- YouTube search through `yt-dlp`
- track selection
- MP3 downloading and caching
- queue management
- playback lifecycle
- FFmpeg streaming
- Icecast output

## Required bot config

Store these values in the bot configuration or environment file:

- `RADIO_API_URL` - example: `http://localhost:3000`
- `RADIO_API_TOKEN` - must match the radio server `API_TOKEN`
- `RADIO_MOUNT` - example: `/stream` or `/highrise`
- `RADIO_LISTENER_URL` - example: `http://localhost:8000/stream`

If the radio server is exposed publicly, use the public listener URL instead of localhost.

Example:

```text
RADIO_API_URL=https://radio.domain.com:3000
RADIO_API_TOKEN=your-secret-token
RADIO_MOUNT=/music
RADIO_LISTENER_URL=https://radio.domain.com/music
```

## Authentication

All control requests must include:

```http
Authorization: Bearer <token>
```

Example header:

```http
Authorization: Bearer your-secret-token
```

## Main API flow

1. Bot receives a user request.
2. Bot validates permissions and cooldowns.
3. Bot sends a request to the radio server.
4. Radio server searches YouTube.
5. Radio server selects a playable track.
6. Radio server downloads or reuses a cached MP3.
7. Radio server queues the track.
8. Radio server starts or continues playback.
9. Bot receives a structured response.
10. Bot shows the result to the user.

## Core endpoints

### Health

`GET /health`

Use this to check whether the radio server is alive and to read the current stream URL/state.

### Play

`POST /play`

Body:

```json
{
  "query": "song name"
}
```

Optional fields supported by the current backend:

- `query`
- `url`
- `input`

Example response fields:

- `track` - the queued or cached song
- `queueLength` - number of queued items
- `radio` - current internal radio state

### Skip

`POST /skip`

Use this to skip the current track.

Optional body:

```json
{
  "count": 1
}
```

### Queue

`GET /queue`

Use this to read the queue, now playing state, and prepared next track.

### Now playing

`GET /now-playing`

Use this for live UI updates, embeds, or status messages.

## Response style for bots

Bots should treat the radio server as a service that returns structured JSON acknowledgements.

Typical bot-friendly response fields:

- `ok`
- `message`
- `track`
- `queueLength`
- `position`
- `radio`
- `nowPlaying`

Example queue acknowledgement:

```json
{
  "ok": true,
  "message": "Song added to queue",
  "position": 3
}
```

## Listener URL usage

The radio server publishes an Icecast stream URL.

Local example:

```text
http://localhost:8000/stream
```

Public example:

```text
https://radio.domain.com/stream
```

Bots should send listeners directly to the stream URL returned by the radio server or stored in bot config.

## Mount usage

This service is designed so future bots/apps can point at different mounts, for example:

- `/stream`
- `/radio-mount`
- `/music`
- `/party-room`

For the current build, use the configured Icecast mount in `.env` and the listener URL reported by `/health`.

## Practical integration example

Example bot pseudocode:

```text
if user requests song:
  validate request
  POST /play with Authorization bearer token
  read returned JSON
  show queue position or error message to user

if user requests skip:
  POST /skip with Authorization bearer token
  show confirmation
```

## Environment variables for the radio server

The radio server reads its configuration from `.env`.

Important values:

- `API_TOKEN`
- `ICECAST_HOST`
- `ICECAST_PORT`
- `ICECAST_MOUNT`
- `ICECAST_PASSWORD`
- `PUBLIC_STREAM_URL`

## Deployment note

Future bots should never stream audio themselves.

They should only call the radio server API and use the stream URL for listeners.
