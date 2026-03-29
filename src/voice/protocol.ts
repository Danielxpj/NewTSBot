/** TS3 protocol constants and types */

export enum PacketType {
  Voice = 0,
  VoiceWhisper = 1,
  Command = 2,
  CommandLow = 3,
  Ping = 4,
  Pong = 5,
  Ack = 6,
  AckLow = 7,
  Init = 8,
}

export enum PacketFlags {
  None = 0x00,
  Fragmented = 0x10,
  NewProtocol = 0x20,
  Compressed = 0x40,
  Unencrypted = 0x80,
}

export enum Codec {
  SpeexNarrowband = 0,
  SpeexWideband = 1,
  SpeexUltraWideband = 2,
  CeltMono = 3,
  OpusVoice = 4,
  OpusMusic = 5,
}

export interface PacketHeader {
  mac: Buffer;
  packetId: number;
  clientId: number;
  flags: number;
  type: PacketType;
}

export interface Packet {
  header: PacketHeader;
  payload: Buffer;
  raw?: Buffer;
}

/** TS3 version info to present during login */
export const CLIENT_VERSION = {
  platform: "Windows",
  version: "3.6.2 [Build: 1690193193]",
  sign: "DX5NIYLvfJEUjuIbCidnoeozxIDRRkpq3I9vVMBmE9L2qnekOoBzSenkzsg2lC9CMv8K5hkEYAkT+a0jRatchw==",
};

/** Known HWID for bots */
export const HWID = "cd1ece47e1e44e14a37e1e9eb7a1e228,8836c25d3e1a4d4d916a6a0c2e089e77";

/** Encode a TS3 escape string */
export function ts3escape(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/\//g, "\\/")
    .replace(/ /g, "\\s")
    .replace(/\|/g, "\\p")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

/** Decode a TS3 escaped string */
export function ts3unescape(str: string): string {
  return str
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\p/g, "|")
    .replace(/\\s/g, " ")
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\");
}

/** Parse a TS3 command response into key-value pairs */
export function parseResponse(data: string): Record<string, string>[] {
  return data.split("|").map((group) => {
    const obj: Record<string, string> = {};
    for (const part of group.trim().split(" ")) {
      const idx = part.indexOf("=");
      if (idx === -1) {
        obj[part] = "";
      } else {
        obj[part.substring(0, idx)] = ts3unescape(part.substring(idx + 1));
      }
    }
    return obj;
  });
}

/** Build a TS3 command string from name + params */
export function buildCommand(
  name: string,
  params: Record<string, string | number>
): string {
  const parts = [name];
  for (const [key, val] of Object.entries(params)) {
    if (val === "") {
      parts.push(key);
    } else {
      parts.push(`${key}=${ts3escape(String(val))}`);
    }
  }
  return parts.join(" ");
}
