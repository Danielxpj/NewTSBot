import fs from "fs";
import path from "path";

const fileLoggingEnabled = process.env.LOG_FILE !== "false";

const logsDir = path.join(process.cwd(), "logs");
if (fileLoggingEnabled) {
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const logFile = fileLoggingEnabled ? path.join(logsDir, `bot_${stamp}.log`) : "";

// Use SYNCHRONOUS file writes so nothing is lost on crash
const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

function write(level: string, args: unknown[]): void {
  if (!fileLoggingEnabled) return;
  const line = `[${level}] ${args.map(String).join(" ")}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    // If file write fails, at least stdout still works
  }
}

console.log = (...args: unknown[]) => { originalLog(...args); write("LOG", args); };
console.warn = (...args: unknown[]) => { originalWarn(...args); write("WRN", args); };
console.error = (...args: unknown[]) => { originalError(...args); write("ERR", args); };

// Catch ALL crashes and write synchronously
process.on("uncaughtException", (err) => {
  const msg = `[CRASH] uncaughtException: ${err.message}\n${err.stack}\n`;
  originalError(msg);
  if (fileLoggingEnabled) {
    try { fs.appendFileSync(logFile, msg); } catch { /* */ }
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = `[CRASH] unhandledRejection: ${reason}\n`;
  originalError(msg);
  if (fileLoggingEnabled) {
    try { fs.appendFileSync(logFile, msg); } catch { /* */ }
  }
});

export const LOG_FILE = logFile;
