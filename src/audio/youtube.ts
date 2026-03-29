import { spawn } from "child_process";
import { Config } from "../config";

export interface TrackInfo {
  title: string;
  url: string;
  audioUrl: string;
  duration: string;
  requestedBy: string;
}

/** Resolve a YouTube URL or search query into track info using yt-dlp */
export async function resolveTrack(
  query: string,
  requestedBy: string
): Promise<TrackInfo> {
  const isUrl =
    query.startsWith("http://") || query.startsWith("https://");
  const args = [
    "--no-playlist",
    "--print",
    "%(title)s\n%(webpage_url)s\n%(duration_string)s",
    "-f",
    "bestaudio[acodec=opus]/bestaudio",
    "--get-url",
  ];

  if (!isUrl) {
    args.unshift("--default-search", "ytsearch");
  }

  args.push(query);

  const output = await runYtDlp(args);
  const lines = output.trim().split("\n").filter((l) => l.length > 0);

  if (lines.length < 4) {
    throw new Error(`yt-dlp returned unexpected output: ${output}`);
  }

  return {
    title: lines[0],
    url: lines[1],
    duration: lines[2],
    audioUrl: lines[3],
    requestedBy,
  };
}

/** Get the direct audio stream URL for a YouTube video */
export async function getAudioUrl(videoUrl: string): Promise<string> {
  const args = [
    "--no-playlist",
    "-f",
    "bestaudio[acodec=opus]/bestaudio",
    "--get-url",
    videoUrl,
  ];

  const output = await runYtDlp(args);
  const url = output.trim().split("\n")[0];
  if (!url) throw new Error("yt-dlp returned no audio URL");
  return url;
}

function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(Config.bin.ytdlp, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(`yt-dlp exited with code ${code}: ${stderr.slice(0, 500)}`)
        );
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`yt-dlp not found. Install it: https://github.com/yt-dlp/yt-dlp\n${err.message}`));
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      proc.kill();
      reject(new Error("yt-dlp timeout (30s)"));
    }, 30000);
  });
}

/** Check if yt-dlp is available */
export async function checkYtDlp(): Promise<boolean> {
  try {
    await runYtDlp(["--version"]);
    return true;
  } catch {
    return false;
  }
}
