# NewTSBot — QA Fixes Design (2026-04-14)

## Scope

Six targeted fixes surfaced during a deep audit. TypeScript build was already
green; all changes preserve behavior except where explicitly corrected.

## Fixes

### 1. Multi-prefix command parsing (`/help` bug)

**Problem.** `src/commands/handler.ts` hardcoded `PREFIX = "!"`. Messages like
`/help` were silently dropped.

**Change.** Replaced with `PREFIXES = ["!", "/"]` and a `stripPrefix(msg)`
helper that returns the body or `null`. Help output mentions both prefixes;
logging uses the primary prefix (`!`) for consistency.

### 2. Dotenv load order (logging toggle was ineffective)

**Problem.** `index.ts` imports `./logger` before `./bot` (which imports
`./config`, which loads dotenv). `logger.ts` therefore read `process.env.LOG_FILE`
before `.env` was applied — so `LOG_FILE=false` never took effect.

**Change.** `logger.ts` now calls `dotenv.config()` itself at module top.
Also added `LOG_CONSOLE=false` to silence stdout (file-only mode), and accept
`0`/`off` as truthy-false for `LOG_FILE`. Errors are always printed to stderr
regardless, because silent crashes are worse than noisy ones.

### 3. Reconnect resource leaks

**Problem.** `bot.ts#connectVoice` was re-entered on `disconnected` events
without tearing down the old `VoiceClient`, old `AudioPlayer`, or old
listeners. Each reconnect leaked an ffmpeg child process, an Opus encoder,
and a frame timer. `connectQuery` had the same pattern.

**Change.**
- At the top of `connectVoice`: `player.stop()`, `removeAllListeners()`,
  and `voiceClient.disconnect()` on the previous instances before creating
  new ones.
- At the top of `connectQuery`: `query.quit()` on the previous instance.
- Reconnect `setTimeout` handles are now stored on the class and cleared
  on `stop()`, and guarded so overlapping disconnects don't schedule
  multiple reconnects.

### 4. Pause memory growth

**Problem.** `AudioPipeline.pause()` only gated the frame-send `tick()`.
The ffmpeg stdout handler kept encoding PCM into `opusFrames[]` while
paused, so a long pause buffered the remainder of the track in memory.

**Change.** `pause()` now calls `this.ffmpeg.stdout.pause()` and `resume()`
calls `.resume()`. Node backpressures ffmpeg via the OS pipe; memory usage
flatlines during pause.

### 5. yt-dlp timeout leak

**Problem.** The 30s timeout in `runYtDlp` was never cleared on success,
briefly keeping the event loop hot after each resolve.

**Change.** Capture the timeout handle; `clearTimeout` in both `close`
and `error` handlers.

### 6. Config default aligned with README

**Problem.** `AUDIO_VOLUME` defaulted to `"10"` in code but README
documents `85`.

**Change.** Code default is now `"85"`.

## Out of scope

- Voice protocol layer (`src/voice/*.ts`): 2100 lines, functional, not
  touched to avoid regressions.
- Test infrastructure: no tests exist yet; adding a framework is its own
  initiative.
- Pipeline refactor: works well; fade/prebuffer logic intentionally
  preserved.

## Verification

- `npx tsc --noEmit` — clean.
- Manual smoke test on a real TS3 server is task 7.2 in `task.md`.
