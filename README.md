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

## Architecture

- **ServerQuery** (TCP) - monitors channel chat, sends responses
- **Voice Client** (UDP) - connects as TS3 client, streams Opus audio
- **Audio Pipeline** - yt-dlp -> ffmpeg -> Opus encoding -> voice stream
