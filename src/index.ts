import "./logger"; // must be first — patches console.* to write to logs/
import { LOG_FILE } from "./logger";
import { MusicBot } from "./bot";

const bot = new MusicBot();

// Graceful shutdown
process.on("SIGINT", async () => {
  await bot.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bot.stop();
  process.exit(0);
});

// unhandledRejection + uncaughtException are handled in logger.ts

console.log(`[Boot] Log file: ${LOG_FILE}`);

// Start
bot.start().catch((err) => {
  console.error("[Fatal]", err.message);
  process.exit(1);
});
