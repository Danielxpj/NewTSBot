import { config } from "dotenv";
config();

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env var: ${key}`);
  return val;
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
    volume: parseInt(env("AUDIO_VOLUME", "80")) / 100,
  },
} as const;
