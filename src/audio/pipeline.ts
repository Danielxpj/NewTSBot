import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import OpusScript from "opusscript";
import { Config } from "../config";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 samples
const PCM_FRAME_BYTES = FRAME_SIZE * CHANNELS * 2; // 960 * 2 * 2 = 3840 bytes

export class AudioPipeline extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private encoder: OpusScript | null = null;
  private pcmBuffer: Buffer = Buffer.alloc(0);
  private playing = false;
  private paused = false;
  private volume: number;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private opusFrames: Buffer[] = [];
  private frameIndex = 0;
  private streamReady = false;
  private prebufferFrames = 25; // ~500ms prebuffer

  constructor(volume: number = 0.85) {
    super();
    this.volume = volume;
  }

  /** Start streaming audio from a URL through ffmpeg → Opus */
  async start(audioUrl: string): Promise<void> {
    this.stop();

    this.encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    this.encoder.setBitrate(96000);
    this.pcmBuffer = Buffer.alloc(0);
    this.opusFrames = [];
    this.frameIndex = 0;
    this.streamReady = false;
    this.playing = true;
    this.paused = false;

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

      this.ffmpeg.stdout?.on("data", (chunk: Buffer) => {
        if (!this.playing) return;

        // Append to PCM buffer
        this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);

        // Encode complete frames to Opus
        while (this.pcmBuffer.length >= PCM_FRAME_BYTES) {
          const frame = this.pcmBuffer.subarray(0, PCM_FRAME_BYTES);
          this.pcmBuffer = this.pcmBuffer.subarray(PCM_FRAME_BYTES);

          try {
            const opusFrame = this.encoder!.encode(frame, FRAME_SIZE);
            this.opusFrames.push(Buffer.from(opusFrame));
          } catch (err) {
            console.error("[Audio] Opus encode error:", (err as Error).message);
          }
        }

        // Start playback after prebuffer is filled
        if (!this.streamReady && this.opusFrames.length >= this.prebufferFrames) {
          this.streamReady = true;
          this.startFrameTimer();
          resolve();
        }
      });

      this.ffmpeg.on("close", (code) => {
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

  private startFrameTimer(): void {
    if (this.frameTimer) return;

    // Send frames at 20ms intervals
    this.frameTimer = setInterval(() => {
      if (this.paused || !this.playing) return;

      if (this.frameIndex < this.opusFrames.length) {
        const frame = this.opusFrames[this.frameIndex++];
        this.emit("frame", frame);
      } else if (!this.ffmpeg || this.ffmpeg.killed) {
        // ffmpeg done and all frames played
        this.stop();
        this.emit("end");
      }
      // else: buffer underrun, wait for more frames
    }, FRAME_DURATION_MS);
  }

  /** Stop the audio pipeline */
  stop(): void {
    this.playing = false;
    this.paused = false;
    this.streamReady = false;

    if (this.frameTimer) {
      clearInterval(this.frameTimer);
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
    this.pcmBuffer = Buffer.alloc(0);
  }

  /** Pause playback */
  pause(): void {
    this.paused = true;
  }

  /** Resume playback */
  resume(): void {
    this.paused = false;
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
    const proc = spawn("ffmpeg", ["-version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}
