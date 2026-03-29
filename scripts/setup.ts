/**
 * Setup script — downloads yt-dlp and ffmpeg into ./bin/
 * Run: npx tsx scripts/setup.ts
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const BIN_DIR = path.resolve(__dirname, "..", "bin");

const YTDLP_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const FFMPEG_URL =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

async function main() {
  console.log("=== NewTSBot Setup ===\n");

  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  const ytdlpPath = path.join(BIN_DIR, "yt-dlp.exe");
  const ffmpegPath = path.join(BIN_DIR, "ffmpeg.exe");

  // Download yt-dlp
  if (fs.existsSync(ytdlpPath)) {
    console.log("[yt-dlp] Already exists, skipping download.");
  } else {
    console.log("[yt-dlp] Downloading...");
    execSync(`curl -L -o "${ytdlpPath}" "${YTDLP_URL}"`, {
      stdio: "inherit",
    });
    console.log("[yt-dlp] Done.");
  }

  // Download ffmpeg
  if (fs.existsSync(ffmpegPath)) {
    console.log("[ffmpeg] Already exists, skipping download.");
  } else {
    console.log("[ffmpeg] Downloading...");
    const zipPath = path.join(BIN_DIR, "ffmpeg.zip");
    execSync(`curl -L -o "${zipPath}" "${FFMPEG_URL}"`, {
      stdio: "inherit",
    });
    console.log("[ffmpeg] Extracting...");
    execSync(
      `unzip -j -o "${zipPath}" "*/bin/ffmpeg.exe" -d "${BIN_DIR}"`,
      { stdio: "inherit" }
    );
    fs.unlinkSync(zipPath);
    console.log("[ffmpeg] Done.");
  }

  // Verify
  console.log("\nVerifying...");
  try {
    const ytVer = execSync(`"${ytdlpPath}" --version`).toString().trim();
    console.log(`  yt-dlp: ${ytVer}`);
  } catch {
    console.error("  yt-dlp: FAILED");
  }

  try {
    const ffVer = execSync(`"${ffmpegPath}" -version`)
      .toString()
      .split("\n")[0];
    console.log(`  ffmpeg: ${ffVer}`);
  } catch {
    console.error("  ffmpeg: FAILED");
  }

  // Create .env if missing
  const envPath = path.resolve(__dirname, "..", ".env");
  const envExample = path.resolve(__dirname, "..", ".env.example");
  if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envPath);
    console.log("\n.env created from .env.example — fill in your credentials.");
  }

  console.log("\nSetup complete! Run: npm run dev");
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
