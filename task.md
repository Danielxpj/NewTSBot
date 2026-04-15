# NewTSBot — QA & Fixes Task List

Audit date: 2026-04-14
Scope: Fix `/help` prefix bug + deep code QA fixes + logging toggle.

Mark each task complete by changing `[ ]` to `[x]`.

---

## 0. Fix logging toggle (`.env` `LOG_FILE=false` was ignored)

- [x] **0.1** In `src/logger.ts`, call `dotenv.config()` at module top (was read before `config.ts` loaded dotenv).
- [x] **0.2** Accept `false`/`0`/`off` as disable values for `LOG_FILE`.
- [x] **0.3** Add `LOG_CONSOLE=false` to silence stdout (file-only).
- [x] **0.4** Document both env vars in `README.md`.

## 1. Fix `/help` (primary ask)

- [x] **1.1** Replace `PREFIX = "!"` with `PREFIXES = ["!", "/"]` in `src/commands/handler.ts`.
- [x] **1.2** Add `stripPrefix()` helper; `handleMessage()` uses it.
- [x] **1.3** Help command output shows both prefixes.
- [x] **1.4** Update `bot.ts` startup log to mention both.
- [x] **1.5** Update `README.md` commands section.
- [ ] **1.6** Manual test in TS channel: `/help`, `!help`, `/play ...`, `!play ...` — all four work.

## 2. Fix reconnect resource leaks

- [x] **2.1** `connectVoice()` tears down old `voiceClient`, `player`, and listeners before creating new ones.
- [x] **2.2** `connectQuery()` calls `quit()` + `removeAllListeners()` on old instance.
- [x] **2.3** Reconnect timers stored on the class; guarded against double-scheduling.
- [x] **2.4** `stop()` clears pending reconnect timers.
- [ ] **2.5** Manual test: kill network mid-playback, confirm reconnect, no duplicate "Now playing".

## 3. Fix pause memory growth

- [x] **3.1** `AudioPipeline.pause()` calls `ffmpeg.stdout.pause()`.
- [x] **3.2** `resume()` calls `ffmpeg.stdout.resume()`.
- [ ] **3.3** Manual test: `!play <long track>`, `!pause` 60s, `!resume` — continues without drift.

## 4. Clear yt-dlp timeout leak

- [x] **4.1** Capture timeout handle in `runYtDlp()`.
- [x] **4.2** `clearTimeout` in both `close` and `error` handlers.
- [ ] **4.3** Manual test: SIGINT after a play command — process exits within 1s, not 30s.

## 5. Align config default with README

- [x] **5.1** `AUDIO_VOLUME` default changed from `"10"` to `"85"` in `src/config.ts`.
- [x] **5.2** README `.env` example already says `85`.

## 6. Documentation

- [x] **6.1** Design doc written to `docs/superpowers/specs/2026-04-14-bot-qa-fixes-design.md`.
- [ ] **6.2** Commit changes (user's call — not auto-committed).

## 7. Verification

- [x] **7.1** `npx tsc --noEmit` — zero errors.
- [ ] **7.2** `npm run dev` against a real TS3 server — full command smoke test.
- [ ] **7.3** Check `logs/` for `[CRASH]` / unhandled rejections after 10-min run.
- [ ] **7.4** Commit (single commit or per section — user's call).

---

## Out of scope (explicitly deferred)

- Voice protocol layer audit (`src/voice/*.ts` — 2100 lines, working)
- Adding automated tests (separate initiative)
- Refactoring the audio pipeline (works; don't touch)
- Command ACL / permissions
