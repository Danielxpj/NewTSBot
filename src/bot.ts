import { TeamSpeak, QueryProtocol, TextMessageTargetMode } from "ts3-nodejs-library";
import { Config } from "./config";
import { VoiceClient } from "./voice/client";
import { AudioPlayer } from "./audio/player";
import { handleMessage } from "./commands/handler";
import { checkYtDlp } from "./audio/youtube";
import { checkFfmpeg } from "./audio/pipeline";

export class MusicBot {
  private query: TeamSpeak | null = null;
  private voiceClient: VoiceClient | null = null;
  private player: AudioPlayer | null = null;
  private running = false;

  async start(): Promise<void> {
    console.log("=== TeamSpeak Music Bot ===\n");

    // Check dependencies
    await this.checkDependencies();

    // Connect voice client (UDP)
    await this.connectVoice();

    // Connect ServerQuery (TCP) — non-fatal if it fails
    try {
      await this.connectQuery();
    } catch (err) {
      console.warn(`[Query] ServerQuery connection failed: ${(err as Error).message}`);
      console.warn("[Query] Bot will run without ServerQuery (voice-only mode)");
      this.query = null;
    }

    this.running = true;
    console.log("\n[Bot] Ready! Listening for commands in channel chat.");
    console.log("[Bot] Type !help in the channel for available commands.\n");
  }

  private async checkDependencies(): Promise<void> {
    console.log("[Bot] Checking dependencies...");

    const [hasYtDlp, hasFfmpeg] = await Promise.all([
      checkYtDlp(),
      checkFfmpeg(),
    ]);

    if (!hasYtDlp) {
      throw new Error(
        "yt-dlp not found! Install from: https://github.com/yt-dlp/yt-dlp"
      );
    }
    console.log("  yt-dlp: OK");

    if (!hasFfmpeg) {
      throw new Error(
        "ffmpeg not found! Install from: https://ffmpeg.org/download.html"
      );
    }
    console.log("  ffmpeg: OK");
  }

  private async connectVoice(): Promise<void> {
    console.log(
      `\n[Bot] Connecting voice to ${Config.ts.host}:${Config.ts.voicePort}...`
    );

    this.voiceClient = new VoiceClient({
      host: Config.ts.host,
      port: Config.ts.voicePort,
      nickname: Config.ts.botNickname,
      channel: Config.ts.channel,
      serverPassword: Config.ts.serverPassword || undefined,
    });

    this.voiceClient.on("error", (err) => {
      console.error("[Voice] Error:", err.message);
    });

    this.voiceClient.on("disconnected", () => {
      console.log("[Voice] Disconnected");
      if (this.running) {
        console.log("[Voice] Attempting reconnect in 5s...");
        setTimeout(() => this.connectVoice(), 5000);
      }
    });

    try {
      await this.voiceClient.connect();
      console.log("[Voice] Connected successfully");
    } catch (err) {
      console.warn(
        `[Voice] Connection failed: ${(err as Error).message}`
      );
      console.warn(
        "[Voice] Bot will operate in command-only mode (no audio playback)"
      );
    }

    // Listen for text messages via voice protocol
    this.voiceClient!.on("textmessage", (event: { msg: string; invokerName: string }) => {
      handleMessage(event.msg, event.invokerName, this.player!, (response) => {
        this.sendChannelMessage(response);
      });
    });

    // Create audio player
    this.player = new AudioPlayer(this.voiceClient!, Config.audio.volume);

    this.player.on("trackStart", (track) => {
      this.sendChannelMessage(
        `Now playing: ${track.title} [${track.duration}]`
      );
    });

    this.player.on("queueEmpty", () => {
      this.sendChannelMessage("Queue finished.");
    });

    this.player.on("trackError", (track, err) => {
      this.sendChannelMessage(
        `Failed to play: ${track.title} - ${(err as Error).message}`
      );
    });
  }

  private async connectQuery(): Promise<void> {
    console.log(
      `[Bot] Connecting ServerQuery to ${Config.ts.host}:${Config.ts.queryPort}...`
    );

    // Create instance first with autoConnect: false so we can attach
    // the error handler BEFORE the connection attempt. This prevents
    // late ssh2 'error' events from crashing the process.
    const ts = new TeamSpeak({
      host: Config.ts.host,
      queryport: Config.ts.queryPort,
      username: Config.ts.queryUsername,
      password: Config.ts.queryPassword,
      nickname: `${Config.ts.botNickname}_query`,
      protocol: QueryProtocol.SSH,
      autoConnect: false,
    });

    ts.on("error", (err) => {
      console.error("[Query] Error:", err.message);
    });

    await ts.connect();
    this.query = ts;

    console.log("[Query] Connected to ServerQuery");

    // Select the first virtual server
    const servers = await this.query.serverList();
    if (servers.length > 0) {
      await this.query.useByPort(servers[0].port);
      console.log(`[Query] Using server: ${servers[0].name}`);
    }

    // Register for channel text messages
    await this.query.registerEvent("textchannel");
    await this.query.registerEvent("textprivate");

    // Listen for text messages
    this.query.on("textmessage", (event) => {
      // Ignore our own messages
      if (event.invoker.nickname === `${Config.ts.botNickname}_query`) return;

      // Only process channel messages (targetmode 2)
      if (event.targetmode !== TextMessageTargetMode.CHANNEL) return;

      const msg = event.msg;
      const invokerName = event.invoker.nickname;

      handleMessage(msg, invokerName, this.player!, (response) => {
        this.sendChannelMessage(response);
      });
    });

    this.query.on("close", () => {
      console.log("[Query] Connection closed");
      if (this.running) {
        console.log("[Query] Reconnecting in 5s...");
        setTimeout(() => this.connectQuery(), 5000);
      }
    });
  }

  private sendChannelMessage(msg: string): void {
    // Prefer voice protocol (always available) over ServerQuery
    if (this.voiceClient) {
      this.voiceClient.sendTextMessage(msg);
      return;
    }
    // Fallback to ServerQuery if available
    this.query?.sendTextMessage(
      "0",
      TextMessageTargetMode.CHANNEL,
      msg
    ).catch((e: Error) => {
      console.error("[Bot] Failed to send message:", e.message);
    });
  }

  async stop(): Promise<void> {
    console.log("\n[Bot] Shutting down...");
    this.running = false;

    this.player?.stop();
    this.voiceClient?.disconnect();

    if (this.query) {
      await this.query.quit().catch(() => {});
    }

    console.log("[Bot] Goodbye!");
  }
}
