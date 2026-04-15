import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import OpusScript from "opusscript";
import { Config } from "../config";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 samples
const PCM_FRAME_BYTES = FRAME_SIZE * CHANNELS * 2; // 960 * 2 * 2 = 3840 bytes
const FRAME_DURATION_NS = BigInt(FRAME_DURATION_MS) * 1_000_000n; // 20ms in nanoseconds

// Fade duration in frames (each frame = 20ms)
const FADE_FRAMES = 15; // 300ms fade-in / fade-out

// PCM buffer pool to reduce GC pressure
const PCM_POOL_SIZE = 256 * 1024; // 256KB pre-allocated buffer

// Silence frame — a single encoded silent Opus frame for underrun fill
let SILENCE_FRAME: Buffer | null = null;

function getSilenceFrame(encoder: OpusScript): Buffer {
  if (!SILENCE_FRAME) {
    const silentPcm = Buffer.alloc(PCM_FRAME_BYTES, 0);
    const encoded = encoder.encode(silentPcm, FRAME_SIZE);
    SILENCE_FRAME = Buffer.from(encoded);
  }
  return SILENCE_FRAME;
}

export class AudioPipeline extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private encoder: OpusScript | null = null;
  private pcmPool: Buffer = Buffer.alloc(PCM_POOL_SIZE);
  private pcmPoolUsed = 0;
  private playing = false;
  private paused = false;
  private volume: number;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private opusFrames: Buffer[] = [];
  private frameIndex = 0;
  private streamReady = false;
  private ffmpegDone = false;
  private _loggedWaiting = false;
  private prebufferFrames = 40; // ~800ms prebuffer for smoother start
  private totalFrameCount = 0; // total frames encoded (for fade tracking)
  private underrunCount = 0; // consecutive underruns for adaptive silence
  // Ring buffer of last FADE_FRAMES PCM frames for fade-out re-encoding
  private recentPcmFrames: Buffer[] = [];

  constructor(volume: number = 0.85) {
    super();
    this.volume = volume;
  }

  /** Apply fade-in/fade-out gain to a PCM frame in-place */
  private applyFade(pcm: Buffer, frameNumber: number, totalEncoded: number, isFinalBatch: boolean): void {
    let gain = 1.0;

    // Fade-in: ramp up over first FADE_FRAMES
    if (frameNumber < FADE_FRAMES) {
      // Smooth ease-in curve (sine)
      gain = Math.sin((frameNumber / FADE_FRAMES) * (Math.PI / 2));
    }

    // Fade-out: ramp down over last FADE_FRAMES (only if we know stream is ending)
    if (isFinalBatch && totalEncoded >= FADE_FRAMES) {
      const framesFromEnd = totalEncoded - frameNumber;
      if (framesFromEnd <= FADE_FRAMES) {
        // Smooth ease-out curve (cosine)
        const fadeOutGain = Math.sin((framesFromEnd / FADE_FRAMES) * (Math.PI / 2));
        gain = Math.min(gain, fadeOutGain);
      }
    }

    if (gain >= 0.999) return; // no change needed

    // Apply gain to every 16-bit sample
    const sampleCount = pcm.length / 2;
    for (let i = 0; i < sampleCount; i++) {
      const sample = pcm.readInt16LE(i * 2);
      pcm.writeInt16LE(Math.round(sample * gain), i * 2);
    }
  }

  /** Start streaming audio from a URL through ffmpeg → Opus */
  async start(audioUrl: string): Promise<void> {
    this.stop();

    this.encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    this.encoder.setBitrate(96000);
    this.pcmPoolUsed = 0;
    this.opusFrames = [];
    this.frameIndex = 0;
    this.streamReady = false;
    this.ffmpegDone = false;
    this.playing = true;
    this.paused = false;
    this.totalFrameCount = 0;
    this.underrunCount = 0;
    this.recentPcmFrames = [];

    return new Promise((resolve, reject) => {
      const volumeFilter = `volume=${this.volume}`;
      this.ffmpeg = spawn(
        Config.bin.ffmpeg,
        [
          "-reconnect", "1",
          "-reconnect_streamed", "1",
          "-reconnect_delay_max", "5",
          "-i", audioUrl,
          "-af", volumeFilter,
          "-f", "s16le",
          "-ar", String(SAMPLE_RATE),
          "-ac", String(CHANNELS),
          "-acodec", "pcm_s16le",
          "pipe:1",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      this.ffmpeg.stderr?.on("data", () => {
        // ffmpeg logs to stderr, ignore unless debugging
      });

      this.ffmpeg.stdout?.on("end", () => {
        console.log(`[Audio] stdout end — frames encoded: ${this.opusFrames.length}, frameIndex: ${this.frameIndex}`);
        this.ffmpegDone = true;
      });

      this.ffmpeg.stdout?.on("data", (chunk: Buffer) => {
        if (!this.playing) return;

        // Append to pooled PCM buffer (grow if needed)
        if (this.pcmPoolUsed + chunk.length > this.pcmPool.length) {
          const newSize = Math.max(this.pcmPool.length * 2, this.pcmPoolUsed + chunk.length);
          const newPool = Buffer.alloc(newSize);
          this.pcmPool.copy(newPool, 0, 0, this.pcmPoolUsed);
          this.pcmPool = newPool;
        }
        chunk.copy(this.pcmPool, this.pcmPoolUsed);
        this.pcmPoolUsed += chunk.length;

        // Encode complete frames to Opus
        let offset = 0;
        while (offset + PCM_FRAME_BYTES <= this.pcmPoolUsed) {
          const frame = Buffer.from(this.pcmPool.subarray(offset, offset + PCM_FRAME_BYTES));
          offset += PCM_FRAME_BYTES;

          // Apply fade-in to early frames
          this.applyFade(frame, this.totalFrameCount, 0, false);
          this.totalFrameCount++;

          // Keep a ring buffer of recent PCM for fade-out re-encoding
          this.recentPcmFrames.push(Buffer.from(frame));
          if (this.recentPcmFrames.length > FADE_FRAMES) {
            this.recentPcmFrames.shift();
          }

          try {
            const opusFrame = this.encoder!.encode(frame, FRAME_SIZE);
            this.opusFrames.push(Buffer.from(opusFrame));
          } catch (err) {
            console.error("[Audio] Opus encode error:", (err as Error).message);
          }
        }

        // Shift remaining bytes to start of pool
        if (offset > 0) {
          const remaining = this.pcmPoolUsed - offset;
          if (remaining > 0) {
            this.pcmPool.copyWithin(0, offset, this.pcmPoolUsed);
          }
          this.pcmPoolUsed = remaining;
        }

        // Start playback after prebuffer is filled
        if (!this.streamReady && this.opusFrames.length >= this.prebufferFrames) {
          this.streamReady = true;
          this.startFrameTimer();
          resolve();
        }
      });

      this.ffmpeg.on("close", (code) => {
        console.log(`[Audio] ffmpeg close code=${code} playing=${this.playing} ffmpegDone=${this.ffmpegDone}`);
        this.ffmpegDone = true;

        // Re-encode last FADE_FRAMES with fade-out applied
        this.applyFadeOutToTail();

        if (this.playing) {
          // ffmpeg finished (end of stream)
          // Let remaining frames play out, then emit 'end'
          if (!this.streamReady) {
            // Stream was too short for prebuffer, start anyway
            this.streamReady = true;
            this.startFrameTimer();
            resolve();
          }
        }
      });

      this.ffmpeg.on("error", (err) => {
        this.stop();
        reject(new Error(`ffmpeg error: ${err.message}`));
      });

      // Timeout if ffmpeg doesn't produce data
      setTimeout(() => {
        if (!this.streamReady && this.playing) {
          this.stop();
          reject(new Error("ffmpeg timeout: no audio data produced"));
        }
      }, 15000);
    });
  }

  /** Re-encode the tail frames with fade-out applied for smooth ending */
  private applyFadeOutToTail(): void {
    if (!this.encoder) return;
    const total = this.opusFrames.length;
    const pcmCount = this.recentPcmFrames.length;
    if (total < pcmCount || pcmCount === 0) return;

    // Re-encode the last pcmCount frames with fade-out gain
    for (let i = 0; i < pcmCount; i++) {
      const pcm = this.recentPcmFrames[i];
      const framesFromEnd = pcmCount - i;
      // Sine ease-out curve
      const gain = Math.sin((framesFromEnd / pcmCount) * (Math.PI / 2));

      if (gain < 0.999) {
        const sampleCount = pcm.length / 2;
        for (let s = 0; s < sampleCount; s++) {
          const sample = pcm.readInt16LE(s * 2);
          pcm.writeInt16LE(Math.round(sample * gain), s * 2);
        }
      }

      try {
        const opusFrame = this.encoder.encode(pcm, FRAME_SIZE);
        // Replace the corresponding opus frame in the array
        this.opusFrames[total - pcmCount + i] = Buffer.from(opusFrame);
      } catch (err) {
        console.error("[Audio] Fade-out re-encode error:", (err as Error).message);
      }
    }
    this.recentPcmFrames = [];
  }

  private startFrameTimer(): void {
    if (this.frameTimer) return;

    // High-resolution drift-compensating timer
    // Instead of setInterval (which drifts ~1-5ms per tick), we use
    // setTimeout with hrtime correction to maintain precise 20ms cadence
    let nextFrameTime = process.hrtime.bigint();

    const tick = () => {
      if (!this.playing) return;
      if (this.paused) {
        // While paused, keep ticking but reset the time anchor
        this.frameTimer = setTimeout(tick, FRAME_DURATION_MS);
        nextFrameTime = process.hrtime.bigint() + FRAME_DURATION_NS;
        return;
      }

      if (this.frameIndex < this.opusFrames.length) {
        const frame = this.opusFrames[this.frameIndex++];
        this._loggedWaiting = false;
        this.underrunCount = 0;
        this.emit("frame", frame);
      } else if (this.ffmpegDone) {
        // ffmpeg done and all frames played
        console.log(`[Audio] All frames played (${this.frameIndex}/${this.opusFrames.length}), emitting end`);
        this.stop();
        this.emit("end");
        return; // don't schedule next tick
      } else {
        // Buffer underrun — send silence to avoid pops/clicks
        this.underrunCount++;
        if (this.underrunCount === 1) {
          console.log(`[Audio] Buffer underrun at frameIndex=${this.frameIndex}, filling with silence`);
        }
        if (this.encoder) {
          this.emit("frame", getSilenceFrame(this.encoder));
        }
      }

      // Calculate drift-compensated delay for next frame
      nextFrameTime += FRAME_DURATION_NS;
      const now = process.hrtime.bigint();
      const drift = nextFrameTime - now;
      // Convert ns to ms, clamp to [1, FRAME_DURATION_MS * 2] to avoid negative/huge delays
      const delayMs = Math.max(1, Math.min(FRAME_DURATION_MS * 2, Number(drift) / 1_000_000));

      this.frameTimer = setTimeout(tick, delayMs);
    };

    nextFrameTime = process.hrtime.bigint() + FRAME_DURATION_NS;
    this.frameTimer = setTimeout(tick, FRAME_DURATION_MS);
  }

  /** Stop the audio pipeline */
  stop(): void {
    this.playing = false;
    this.paused = false;
    this.streamReady = false;
    this.ffmpegDone = false;

    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }

    if (this.ffmpeg) {
      this.ffmpeg.kill("SIGKILL");
      this.ffmpeg = null;
    }

    if (this.encoder) {
      this.encoder.delete();
      this.encoder = null;
    }

    this.opusFrames = [];
    this.frameIndex = 0;
    this.pcmPoolUsed = 0;
  }

  /** Pause playback */
  pause(): void {
    this.paused = true;
    // Pause ffmpeg's stdout so PCM stops flowing into opusFrames while paused.
    // Without this, a long pause on a long track buffers the remaining audio in memory.
    this.ffmpeg?.stdout?.pause();
  }

  /** Resume playback */
  resume(): void {
    this.paused = false;
    this.ffmpeg?.stdout?.resume();
  }

  /** Set volume (0.0 - 1.0). Takes effect on next track. */
  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
  }

  isPlaying(): boolean {
    return this.playing && !this.paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getVolume(): number {
    return this.volume;
  }
}

/** Check if ffmpeg is available */
export async function checkFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(Config.bin.ffmpeg, ["-version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}
