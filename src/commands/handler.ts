import { AudioPlayer } from "../audio/player";
import { TrackInfo } from "../audio/youtube";

const PREFIX = "!";

type SendMessage = (msg: string) => void;

interface CommandContext {
  player: AudioPlayer;
  send: SendMessage;
  args: string[];
  invokerName: string;
}

interface Command {
  name: string;
  aliases: string[];
  description: string;
  execute: (ctx: CommandContext) => Promise<void> | void;
}

const commands: Command[] = [
  {
    name: "play",
    aliases: ["p"],
    description: "Play a YouTube URL or search term",
    async execute(ctx) {
      const query = ctx.args.join(" ");
      if (!query) {
        ctx.send("Usage: !play <url or search term>");
        return;
      }

      ctx.send(`Searching: ${query}...`);

      try {
        const track = await ctx.player.addTrack(query, ctx.invokerName);
        if (ctx.player.getQueueLength() > 0) {
          ctx.send(
            `Queued #${ctx.player.getQueueLength()}: [b]${track.title}[/b] [${track.duration}]`
          );
        }
        // If queue was empty, trackStart event in bot.ts sends "Now playing"
      } catch (err) {
        ctx.send(`Error: ${(err as Error).message}`);
      }
    },
  },
  {
    name: "stop",
    aliases: [],
    description: "Stop playback and clear queue",
    execute(ctx) {
      ctx.player.stop();
      ctx.send("Stopped playback and cleared queue.");
    },
  },
  {
    name: "skip",
    aliases: ["s", "next"],
    description: "Skip the current track",
    execute(ctx) {
      const skipped = ctx.player.skip();
      if (skipped) {
        ctx.send(`Skipped: [b]${skipped.title}[/b]`);
      } else {
        ctx.send("Nothing is playing.");
      }
    },
  },
  {
    name: "queue",
    aliases: ["q"],
    description: "Show the current queue",
    execute(ctx) {
      const np = ctx.player.nowPlaying();
      const queue = ctx.player.getQueue();

      let msg = "";
      if (np) {
        msg += `Now playing: [b]${np.title}[/b] [${np.duration}]\n`;
      } else {
        msg += "Nothing is playing.\n";
      }

      if (queue.length > 0) {
        msg += `\nQueue (${queue.length} tracks):\n`;
        queue.slice(0, 10).forEach((track, i) => {
          msg += `${i + 1}. ${track.title} [${track.duration}] (by ${track.requestedBy})\n`;
        });
        if (queue.length > 10) {
          msg += `...and ${queue.length - 10} more`;
        }
      } else {
        msg += "Queue is empty.";
      }

      ctx.send(msg.trim());
    },
  },
  {
    name: "np",
    aliases: ["nowplaying", "current"],
    description: "Show the currently playing track",
    execute(ctx) {
      const np = ctx.player.nowPlaying();
      if (np) {
        const status = ctx.player.isPaused() ? "(paused)" : "";
        ctx.send(
          `Now playing: [b]${np.title}[/b] [${np.duration}] ${status} (requested by ${np.requestedBy})`
        );
      } else {
        ctx.send("Nothing is playing.");
      }
    },
  },
  {
    name: "pause",
    aliases: [],
    description: "Pause playback",
    execute(ctx) {
      if (!ctx.player.isPlaying()) {
        ctx.send("Nothing is playing.");
        return;
      }
      ctx.player.pause();
      ctx.send("Paused.");
    },
  },
  {
    name: "resume",
    aliases: ["unpause"],
    description: "Resume playback",
    execute(ctx) {
      if (!ctx.player.isPaused()) {
        ctx.send("Not paused.");
        return;
      }
      ctx.player.resume();
      ctx.send("Resumed.");
    },
  },
  {
    name: "volume",
    aliases: ["vol", "v"],
    description: "Set volume (0-100)",
    execute(ctx) {
      if (ctx.args.length === 0) {
        ctx.send(`Volume: ${ctx.player.getVolume()}%`);
        return;
      }

      const vol = parseInt(ctx.args[0], 10);
      if (isNaN(vol) || vol < 0 || vol > 100) {
        ctx.send("Usage: !volume <0-100>");
        return;
      }

      ctx.player.setVolume(vol);
      ctx.send(`Volume set to ${vol}% (applies to next track).`);
    },
  },
  {
    name: "help",
    aliases: ["h", "commands"],
    description: "Show available commands",
    execute(ctx) {
      let msg = "Commands:\n";
      for (const cmd of commands) {
        const aliases =
          cmd.aliases.length > 0
            ? ` (aliases: ${cmd.aliases.map((a) => PREFIX + a).join(", ")})`
            : "";
        msg += `${PREFIX}${cmd.name}${aliases} - ${cmd.description}\n`;
      }
      ctx.send(msg.trim());
    },
  },
];

/** Find a command by name or alias */
function findCommand(name: string): Command | undefined {
  const lower = name.toLowerCase();
  return commands.find(
    (cmd) => cmd.name === lower || cmd.aliases.includes(lower)
  );
}

/** Handle an incoming chat message */
export function handleMessage(
  message: string,
  invokerName: string,
  player: AudioPlayer,
  send: SendMessage
): void {
  const trimmed = message.trim();
  if (!trimmed.startsWith(PREFIX)) return;

  const parts = trimmed.slice(PREFIX.length).split(/\s+/);
  const cmdName = parts[0];
  const args = parts.slice(1);

  const cmd = findCommand(cmdName);
  if (!cmd) return; // Unknown command, silently ignore

  console.log(`[CMD] ${invokerName}: ${PREFIX}${cmdName} ${args.join(" ")}`);

  const ctx: CommandContext = {
    player,
    send,
    args,
    invokerName,
  };

  Promise.resolve(cmd.execute(ctx)).catch((err) => {
    console.error(`[CMD] Error in ${cmdName}:`, err);
    send(`Error: ${(err as Error).message}`);
  });
}
