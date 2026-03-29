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

process.on("unhandledRejection", (err) => {
  console.error("[Fatal] Unhandled rejection:", err);
});

// Start
bot.start().catch((err) => {
  console.error("[Fatal]", err.message);
  process.exit(1);
});
