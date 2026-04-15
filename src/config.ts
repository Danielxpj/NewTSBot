import path from "path";
import { config } from "dotenv";
config();

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env var: ${key}`);
  return val;
}

/** Resolve a path relative to the project root */
function resolvePath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
}

export const Config = {
  ts: {
    host: env("TS_SERVER_HOST"),
    voicePort: parseInt(env("TS_SERVER_PORT", "9987")),
    serverPassword: env("TS_SERVER_PASSWORD", ""),
    channel: env("TS_CHANNEL"),
    botNickname: env("TS_BOT_NICKNAME", "MusicBot"),
    queryPort: parseInt(env("TS_QUERY_PORT", "10022")),
    queryUsername: env("TS_QUERY_USERNAME"),
    queryPassword: env("TS_QUERY_PASSWORD"),
  },
  audio: {
    volume: parseInt(env("AUDIO_VOLUME", "85")) / 100,
  },
  bin: {
    ytdlp: resolvePath(env("YTDLP_PATH", "./bin/yt-dlp.exe")),
    ffmpeg: resolvePath(env("FFMPEG_PATH", "./bin/ffmpeg.exe")),
  },
} as const;
