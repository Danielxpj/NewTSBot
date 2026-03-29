import { EventEmitter } from "events";
import { AudioPipeline } from "./pipeline";
import { TrackInfo, resolveTrack, getAudioUrl } from "./youtube";
import { VoiceClient } from "../voice/client";

export class AudioPlayer extends EventEmitter {
  private pipeline: AudioPipeline;
  private voiceClient: VoiceClient;
  private queue: TrackInfo[] = [];
  private currentTrack: TrackInfo | null = null;
  private _isPlaying = false;

  constructor(voiceClient: VoiceClient, volume: number = 0.85) {
    super();
    this.voiceClient = voiceClient;
    this.pipeline = new AudioPipeline(volume);

    this.pipeline.on("frame", (frame: Buffer) => {
      this.voiceClient.sendVoice(frame);
    });

    this.pipeline.on("end", () => {
      console.log(`[Player] Track ended: ${this.currentTrack?.title ?? "unknown"}`);
      this.currentTrack = null;
      this._isPlaying = false;
      this.emit("trackEnd");
      this.playNext();
    });
  }

  /** Add a track to the queue by URL or search term */
  async addTrack(query: string, requestedBy: string): Promise<TrackInfo> {
    const track = await resolveTrack(query, requestedBy);
    this.queue.push(track);

    console.log(`[Player] Queued: ${track.title} [${track.duration}]`);
    this.emit("trackQueued", track);

    // If nothing is playing, start
    if (!this._isPlaying && !this.currentTrack) {
      this.playNext();
    }

    return track;
  }

  /** Play the next track in queue */
  async playNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.currentTrack = null;
      this._isPlaying = false;
      this.voiceClient.sendVoiceStop();
      this.emit("queueEmpty");
      return;
    }

    const track = this.queue.shift()!;
    this.currentTrack = track;
    this._isPlaying = true;

    console.log(`[Player] Now playing: ${track.title}`);
    this.emit("trackStart", track);

    try {
      // Re-resolve audio URL in case it expired
      const audioUrl = await getAudioUrl(track.url);
      await this.pipeline.start(audioUrl);
    } catch (err) {
      console.error(`[Player] Failed to play: ${(err as Error).message}`);
      this.emit("trackError", track, err);
      this.currentTrack = null;
      this._isPlaying = false;
      // Try next track
      this.playNext();
    }
  }

  /** Stop playback and clear queue */
  stop(): void {
    this.pipeline.stop();
    this.voiceClient.sendVoiceStop();
    this.queue = [];
    this.currentTrack = null;
    this._isPlaying = false;
    this.emit("stopped");
  }

  /** Skip current track */
  skip(): TrackInfo | null {
    const skipped = this.currentTrack;
    this.pipeline.stop();
    this.voiceClient.sendVoiceStop();
    this.currentTrack = null;
    this._isPlaying = false;
    this.playNext();
    return skipped;
  }

  /** Pause playback */
  pause(): void {
    this.pipeline.pause();
    this.emit("paused");
  }

  /** Resume playback */
  resume(): void {
    this.pipeline.resume();
    this.emit("resumed");
  }

  /** Set volume (0-100) */
  setVolume(volume: number): void {
    this.pipeline.setVolume(volume / 100);
  }

  /** Get current track */
  nowPlaying(): TrackInfo | null {
    return this.currentTrack;
  }

  /** Get queue */
  getQueue(): TrackInfo[] {
    return [...this.queue];
  }

  /** Get queue length */
  getQueueLength(): number {
    return this.queue.length;
  }

  isPlaying(): boolean {
    return this._isPlaying;
  }

  isPaused(): boolean {
    return this.pipeline.isPaused();
  }

  getVolume(): number {
    return Math.round(this.pipeline.getVolume() * 100);
  }
}
