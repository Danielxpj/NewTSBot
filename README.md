# NewTSBot - TeamSpeak 3 Music Bot

A self-contained TeamSpeak 3 music bot that streams YouTube audio, built in TypeScript.

## Features

- Play YouTube videos/search by keyword
- Song queue with skip, pause, resume
- Volume control
- Channel chat commands

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (must be in PATH)
- [ffmpeg](https://ffmpeg.org/download.html) (must be in PATH)

## Setup

1. Clone the repo
2. `npm install`
3. Copy `.env.example` to `.env` and fill in your TeamSpeak credentials
4. `npm run dev` (development) or `npm run build && npm start` (production)

## .env Configuration

```env
TS_SERVER_HOST=your.ts.server
TS_SERVER_PORT=9987
TS_SERVER_PASSWORD=
TS_CHANNEL=YourChannel
TS_BOT_NICKNAME=MusicBot
TS_QUERY_PORT=10022
TS_QUERY_USERNAME=serveradmin
TS_QUERY_PASSWORD=yourpassword
AUDIO_VOLUME=85
```

## Commands

| Command | Description |
|---------|-------------|
| `!play <url/search>` | Play a YouTube video or search |
| `!stop` | Stop playback, clear queue |
| `!skip` | Skip current track |
| `!queue` | Show current queue |
| `!np` | Show now playing |
| `!pause` | Pause playback |
| `!resume` | Resume playback |
| `!volume <0-100>` | Set volume |
| `!help` | Show commands |

> Commands accept either `!` or `/` as the prefix (e.g. `/play ...` works too).

### Logging

- `LOG_FILE=false` — disable writing to `logs/bot_*.log` (console only).
- `LOG_CONSOLE=false` — silence stdout (file logging only; errors still printed).

## Docker

Runs anywhere Docker does — no Node/ffmpeg/yt-dlp install on the host.

```bash
cp .env.example .env      # fill in credentials
docker compose up -d      # build and start
docker compose logs -f    # follow logs
docker compose down       # stop
```

- `logs/` is bind-mounted for persistent log files.
- Image is Debian-slim + Node 20 + ffmpeg (apt) + yt-dlp (static binary from upstream).
- Runs as non-root user `bot` (uid 1001).
- `tini` handles PID 1 so `SIGTERM`/`SIGINT` cleanly trigger the bot's graceful shutdown.
- `YTDLP_PATH` / `FFMPEG_PATH` in `.env` are ignored inside the container (compose overrides them to the image's Linux paths), so the same `.env` works for local Windows dev and Docker.

To rebuild after code changes: `docker compose build --no-cache` or just `docker compose up -d --build`.

## Architecture

- **ServerQuery** (TCP) - monitors channel chat, sends responses
- **Voice Client** (UDP) - connects as TS3 client, streams Opus audio
- **Audio Pipeline** - yt-dlp -> ffmpeg -> Opus encoding -> voice stream
