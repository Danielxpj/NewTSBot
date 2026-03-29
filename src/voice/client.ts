import dgram from "dgram";
import crypto from "crypto";
import { EventEmitter } from "events";
import {
  PacketType,
  PacketFlags,
  Codec,
  CLIENT_VERSION,
  HWID,
  buildCommand,
  ts3escape,
  parseResponse,
} from "./protocol";
import {
  decodePacket,
  encodePacket,
  encodePing,
  encodePong,
  encodeAck,
} from "./packet";
import {
  eaxEncrypt,
  eaxDecrypt,
  deriveSharedIV,
  derivePacketKeyNonce,
} from "./crypto";
import { generateIdentity, decodeOmega, TS3Identity } from "./identity";
import {
  parseLicenseChain,
  deriveLicenseKey,
  ED25519_N,
  bytesToBigIntLE,
} from "./license";
import { ed25519 } from "@noble/curves/ed25519.js";
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const QuickLZMod: any = require("quicklz");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const QuickLZ: new () => any = QuickLZMod.default ?? QuickLZMod;

// TS3 InitVersion from TSLib reference: 0x5D60CFD0
const INIT_VERSION = 0x5d60cfd0;

// Dummy encryption key/nonce used between Init step 4 and real crypto setup
// "c:\windows\system\firewall32.cpl" split into two 16-byte halves
const DUMMY_KEY = Buffer.from("c:\\windows\\syste", "ascii");
const DUMMY_NONCE = Buffer.from("m\\firewall32.cpl", "ascii");

interface VoiceClientOptions {
  host: string;
  port: number;
  nickname: string;
  channel: string;
  serverPassword?: string;
  identity?: TS3Identity;
}

type VoiceClientState =
  | "disconnected"
  | "init0"
  | "init2"
  | "init4"
  | "crypto"
  | "connecting"
  | "connected"
  | "disconnecting";

/** Returns HH:MM:SS.mmm prefix for log lines */
function ts(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}:${d.getSeconds().toString().padStart(2,"0")}.${d.getMilliseconds().toString().padStart(3,"0")}`;
}

export class VoiceClient extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private state: VoiceClientState = "disconnected";
  private options: VoiceClientOptions;
  private identity: TS3Identity;

  // Packet counters (command starts at 1; ID 0 reserved for legacy clientinitiv)
  private commandCounter = 1;
  private voiceCounter = 0;
  private pingCounter = 0;
  private generationId = 0;

  // Connection state
  private clientId = 0;
  private sharedIV: Buffer | null = null;          // 64-byte SharedIV for real encryption
  private pendingSharedIV: Buffer | null = null;   // stored until clientek is ACK'd
  private dummyKey: Buffer | null = null;           // dummy key for fake encryption
  private dummyNonce: Buffer | null = null;         // dummy nonce for fake encryption
  private encrypted = false;
  private clientEkPacketId = -1;

  // Handshake state
  private initRandom = Buffer.alloc(4);
  private alpha = Buffer.alloc(0);
  private ecdh: crypto.ECDH | null = null; // P-256 for old protocol only
  // ekSeed removed — we use a random scalar for Edwards ECDH, not an Ed25519 seed
  private ekPubBytes: Uint8Array | null = null;  // Ed25519 pub key for clientek

  // Keep-alive
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;

  // Pending command responses
  private pendingCommands: Map<
    number,
    { resolve: (data: string) => void; reject: (err: Error) => void }
  > = new Map();

  // Fragment reassembly (keyed by packetId for correct ordering)
  private fragmentBuffer: Map<number, Buffer> = new Map();
  private fragmentTimer: ReturnType<typeof setTimeout> | null = null;
  private fragmentCompressed = false; // any fragment in current sequence had Compressed flag

  // Channel join: collect channel IDs from channellist, move after channellistfinished
  private targetChannelId = -1;

  constructor(options: VoiceClientOptions) {
    super();
    this.options = options;
    this.identity = options.identity ?? generateIdentity(8);
    console.log(`${ts()} [Voice] Identity securityLevel=${this.identity.securityLevel} keyOffset=${this.identity.keyOffset}`);
  }

  private setState(next: VoiceClientState): void {
    console.log(`${ts()} [Voice] STATE ${this.state} → ${next}`);
    this.state = next;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket("udp4");

      this.socket.on("message", (msg) => {
        try {
          if (this.state !== "connected") {
            console.log(`${ts()} [Voice] RECV ${msg.length}b raw: ${msg.toString("hex")}`);
          }
          this.handlePacket(msg);
        } catch (err) {
          console.error(`${ts()} [Voice] FATAL in message handler: ${(err as Error).message}\n${(err as Error).stack}`);
        }
      });
      this.socket.on("error", (err) => {
        console.error(`${ts()} [Voice] Socket error: ${err.message}`);
        this.emit("error", err);
      });

      this.socket.bind(0, () => {
        console.log(
          `${ts()} [Voice] Connecting to ${this.options.host}:${this.options.port}...`
        );

        const onConnected = () => {
          this.removeListener("error", onError);
          clearTimeout(timeout);
          resolve();
        };
        const onError = (err: Error) => {
          this.removeListener("connected", onConnected);
          clearTimeout(timeout);
          reject(err);
        };
        const timeout = setTimeout(() => {
          this.removeListener("connected", onConnected);
          this.removeListener("error", onError);
          reject(new Error("Connection timeout (15s)"));
        }, 15000);

        this.once("connected", onConnected);
        this.once("error", onError);

        this.sendInit0();
      });
    });
  }

  disconnect(): void {
    this.setState("disconnecting");
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);

    if (this.socket) {
      try {
        this.sendCommandRaw(
          buildCommand("clientdisconnect", {
            reasonid: "8",
            reasonmsg: "leaving",
          })
        );
      } catch {
        // Ignore send errors during disconnect
      }
    }

    setTimeout(() => {
      this.socket?.close();
      this.socket = null;
      this.setState("disconnected");
      this.encrypted = false;
      this.sharedIV = null;
      this.pendingSharedIV = null;
      this.dummyKey = null;
      this.dummyNonce = null;
      this.emit("disconnected");
    }, 200);
  }

  /** Send an Opus voice frame */
  sendVoice(opusData: Buffer): void {
    if (this.state !== "connected" || !this.socket) return;

    const packetId = this.voiceCounter++ & 0xffff;

    // Voice payload: [VoicePacketId:2][Codec:1][OpusData...]
    const voicePayload = Buffer.alloc(3 + opusData.length);
    voicePayload.writeUInt16BE(packetId, 0);
    voicePayload[2] = Codec.OpusMusic;
    opusData.copy(voicePayload, 3);

    if (this.encrypted && this.sharedIV) {
      const header = Buffer.alloc(5);
      header.writeUInt16BE(packetId, 0);
      header.writeUInt16BE(this.clientId, 2);
      header[4] = PacketType.Voice;

      const { key, nonce } = derivePacketKeyNonce(
        this.sharedIV,
        "c2s",
        PacketType.Voice,
        this.generationId,
        packetId
      );

      const { ciphertext, mac } = eaxEncrypt(
        key,
        nonce,
        header,
        voicePayload
      );

      const packet = Buffer.alloc(13 + ciphertext.length);
      mac.copy(packet, 0, 0, 8);
      header.copy(packet, 8);
      ciphertext.copy(packet, 13);
      this.send(packet);
    } else {
      const packet = encodePacket(
        PacketType.Voice,
        voicePayload,
        packetId,
        this.clientId,
        PacketFlags.Unencrypted
      );
      this.send(packet);
    }
  }

  /** Stop sending voice (send silence marker) */
  sendVoiceStop(): void {
    if (this.state !== "connected" || !this.socket) return;

    const packetId = this.voiceCounter++ & 0xffff;
    const voicePayload = Buffer.alloc(3);
    voicePayload.writeUInt16BE(packetId, 0);
    voicePayload[2] = Codec.OpusMusic;

    const packet = encodePacket(
      PacketType.Voice,
      voicePayload,
      packetId,
      this.clientId,
      PacketFlags.Unencrypted
    );
    this.send(packet);
  }

  // ========================================================
  // Init Handshake (steps 0 → 1 → 2 → 3 → 4 → initivexpand)
  // ========================================================

  private sendInit0(): void {
    this.setState("init0");
    this.initRandom = crypto.randomBytes(4);

    // Payload: [version:4][step:1][timestamp:4][random:4][reserved:8] = 21 bytes
    const payload = Buffer.alloc(21);
    payload.writeUInt32BE(INIT_VERSION, 0); // Version
    payload[4] = 0x00;                                      // Step 0
    payload.writeUInt32BE(Math.floor(Date.now() / 1000), 5); // Timestamp
    this.initRandom.copy(payload, 9);                        // Random (A0)
    // Bytes 13-20 remain zeros (reserved)

    const packet = encodePacket(
      PacketType.Init,
      payload,
      101,
      0,
      PacketFlags.Unencrypted
    );
    this.send(packet);

    this.connectionTimeout = setTimeout(() => {
      if (this.state === "init0") {
        console.log(`${ts()} [Voice] Init0 timeout, retrying...`);
        this.sendInit0();
      }
    }, 5000);
  }

  /**
   * Step 1 (Server → Client): [step:1][cookie:16][A0_reversed:4]
   */
  private handleInit1(payload: Buffer): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);

    // payload[0] = step (already checked)
    const cookie = Buffer.from(payload.subarray(1, 17));   // 16 bytes cookie
    const a0Reversed = Buffer.from(payload.subarray(17, 21)); // 4 bytes A0 reversed

    console.log(`${ts()} [Voice] Step1: cookie=${cookie.toString("hex")} a0r=${a0Reversed.toString("hex")}`);

    this.sendInit2(cookie, a0Reversed);
  }

  /**
   * Step 2 (Client → Server): [version:4][step:1][cookie:16][A0r:4] = 25 bytes
   */
  private sendInit2(cookie: Buffer, a0Reversed: Buffer): void {
    this.setState("init2");

    const payload = Buffer.alloc(25);
    payload.writeUInt32BE(INIT_VERSION, 0); // Version
    payload[4] = 0x02;                                      // Step 2
    cookie.copy(payload, 5);                                 // Cookie (16 bytes)
    a0Reversed.copy(payload, 21);                            // A0 reversed (4 bytes)

    const packet = encodePacket(
      PacketType.Init,
      payload,
      101,
      0,
      PacketFlags.Unencrypted
    );
    this.send(packet);

    this.connectionTimeout = setTimeout(() => {
      if (this.state === "init2") {
        console.log(`${ts()} [Voice] Init2 timeout, retrying from Init0...`);
        this.sendInit0(); // Start over
      }
    }, 5000);
  }

  /**
   * Step 3 (Server → Client): [step:1][x:64][n:64][level:4][serverData:100] = 233 bytes
   */
  private handleInit3(payload: Buffer): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);

    if (payload.length < 233) {
      console.error(`${ts()} [Voice] Step3 too short: ${payload.length} bytes (need 233)`);
      return;
    }

    // payload[0] = step (already checked)
    const x = Buffer.from(payload.subarray(1, 65));         // 64 bytes
    const n = Buffer.from(payload.subarray(65, 129));        // 64 bytes
    const level = payload.readUInt32BE(129);                  // 4 bytes
    const serverData = Buffer.from(payload.subarray(133, 233)); // 100 bytes (A2)

    console.log(`${ts()} [Voice] Step3: level=${level} x=${x.subarray(0,8).toString("hex")}... n=${n.subarray(0,8).toString("hex")}... solving RSA puzzle...`);

    // Solve: y = x^(2^level) mod n
    const y = this.solvePuzzle(x, n, level);

    console.log(`${ts()} [Voice] Puzzle solved y=${y.subarray(0,8).toString("hex")}..., sending Init4+clientinitiv`);

    this.sendInit4(x, n, level, serverData, y);
  }

  /**
   * Step 4 (Client → Server):
   * [version:4][step:1][x:64][n:64][level:4][A2:100][y:64][clientinitiv:var]
   */
  private sendInit4(
    x: Buffer,
    n: Buffer,
    level: number,
    serverData: Buffer,
    y: Buffer
  ): void {
    this.setState("init4");

    // Set up ECDH from identity
    this.ecdh = crypto.createECDH("prime256v1");
    this.ecdh.setPrivateKey(this.identity.privateKey);

    // Build clientinitiv command
    this.alpha = crypto.randomBytes(10);
    console.log(`${ts()} [Voice] Init4: alpha=${this.alpha.toString("hex")} omega=${this.identity.omegaBase64.substring(0,24)}...`);

    const clientinitiv =
      `clientinitiv alpha=${ts3escape(this.alpha.toString("base64"))}` +
      ` omega=${ts3escape(this.identity.omegaBase64)}` +
      ` ot=1` +
      ` ip=`;

    const cmdBuf = Buffer.from(clientinitiv, "utf-8");

    // Build payload
    const payloadLen = 4 + 1 + 64 + 64 + 4 + 100 + 64 + cmdBuf.length;
    const payload = Buffer.alloc(payloadLen);
    let offset = 0;

    payload.writeUInt32BE(INIT_VERSION, offset); offset += 4; // Version
    payload[offset] = 0x04; offset += 1;                                      // Step 4
    x.copy(payload, offset); offset += 64;                                     // x
    n.copy(payload, offset); offset += 64;                                     // n
    payload.writeUInt32BE(level, offset); offset += 4;                         // level
    serverData.copy(payload, offset); offset += 100;                           // A2
    y.copy(payload, offset); offset += 64;                                     // y (puzzle solution)
    cmdBuf.copy(payload, offset);                                              // clientinitiv command

    const packet = encodePacket(
      PacketType.Init,
      payload,
      101,
      0,
      PacketFlags.Unencrypted
    );
    this.send(packet);

    // After sending Init step 4, the server encrypts its response with a
    // well-known dummy key. Dummy encryption uses a fixed key/nonce with
    // no per-packet modification.
    this.dummyKey = DUMMY_KEY;
    this.dummyNonce = DUMMY_NONCE;
    this.encrypted = true;

    this.connectionTimeout = setTimeout(() => {
      if (this.state === "init4") {
        console.log(`${ts()} [Voice] Init4 timeout — server did not respond to clientinitiv`);
        this.emit("error", new Error("Init4 timeout — server rejected handshake"));
      }
    }, 10000);
  }

  /** Solve RSA puzzle: y = x^(2^level) mod n via repeated squaring */
  private solvePuzzle(xBuf: Buffer, nBuf: Buffer, level: number): Buffer {
    let x = this.bufToBigInt(xBuf);
    const n = this.bufToBigInt(nBuf);

    if (n === 0n) {
      return Buffer.alloc(64); // Edge case
    }

    // x^(2^level) mod n = square x `level` times
    let result = x % n;
    for (let i = 0; i < level; i++) {
      result = (result * result) % n;
    }

    return this.bigIntToBuf(result, 64);
  }

  private bufToBigInt(buf: Buffer): bigint {
    let result = 0n;
    for (let i = 0; i < buf.length; i++) {
      result = (result << 8n) | BigInt(buf[i]);
    }
    return result;
  }

  private bigIntToBuf(value: bigint, length: number): Buffer {
    const buf = Buffer.alloc(length);
    for (let i = length - 1; i >= 0; i--) {
      buf[i] = Number(value & 0xffn);
      value >>= 8n;
    }
    return buf;
  }

  // (omega encoding is now handled by identity.ts)

  // ========================================================
  // EAX Decryption
  // ========================================================


  // ========================================================
  // Packet Handling
  // ========================================================

  private handlePacket(data: Buffer): void {
    try {
      const packet = decodePacket(data);
      const { header, payload } = packet;

      if (
        header.type !== PacketType.Voice &&
        header.type !== PacketType.Ping
      ) {
        const typeName = PacketType[header.type] ?? `0x${header.type.toString(16)}`;
        console.log(
          `${ts()} [Voice] PACKET type=${typeName} flags=0x${header.flags.toString(16)} pktId=${header.packetId} len=${data.length} state=${this.state}`
        );
      }

      switch (header.type) {
        case PacketType.Init:
          this.handleInitPacket(payload);
          break;

        case PacketType.Command:
        case PacketType.CommandLow:
          this.handleCommandPacket(header, payload, data);
          break;

        case PacketType.Ping:
          this.handlePingPacket(header);
          break;

        case PacketType.Pong:
          break;

        case PacketType.Ack:
        case PacketType.AckLow:
          this.handleAckPacket(header, payload, data);
          break;

        case PacketType.Voice:
        case PacketType.VoiceWhisper:
          break; // Ignore incoming voice

        default:
          console.warn(`${ts()} [Voice] Unhandled packet type=${header.type} flags=0x${header.flags.toString(16)}`);
          break;
      }
    } catch (err) {
      console.error(`${ts()} [Voice] Packet parse error: ${(err as Error).message}\n${(err as Error).stack}`);
    }
  }

  private handleInitPacket(payload: Buffer): void {
    if (payload.length < 1) return;
    const step = payload[0];

    console.log(`${ts()} [Voice] Init step=${step} len=${payload.length} hex=${payload.subarray(0,16).toString("hex")}...`);

    switch (step) {
      case 1:
        this.handleInit1(payload);
        break;
      case 3:
        this.handleInit3(payload);
        break;
      default:
        console.warn(`${ts()} [Voice] Unknown init step=${step}`);
    }
  }

  private handleCommandPacket(
    header: { packetId: number; flags: number; type: number },
    payload: Buffer,
    raw: Buffer
  ): void {
    // Always ACK command packets so the server sends remaining fragments
    this.sendAck(header.packetId);

    // Step 1: get raw decrypted bytes (never convert to string yet — compressed data is binary)
    let rawBytes: Buffer;

    if (header.flags & PacketFlags.Unencrypted) {
      rawBytes = payload;
    } else {
      const mac = raw.subarray(0, 8);
      const fullMac = Buffer.alloc(16);
      mac.copy(fullMac, 0);
      const headerBytes = raw.subarray(8, 11);
      const ciphertext = raw.subarray(11);

      let decrypted: Buffer | null = null;
      let usedKey: Buffer | null = null;
      let usedNonce: Buffer | null = null;
      const modeLabel = this.sharedIV ? "real" : (this.dummyKey ? "dummy" : "none");

      if (this.sharedIV) {
        const kn = derivePacketKeyNonce(this.sharedIV, "s2c", header.type, this.generationId, header.packetId);
        usedKey = kn.key; usedNonce = kn.nonce;
        console.log(`${ts()} [Voice] CMD decrypt real: pktId=${header.packetId} genId=${this.generationId} key=${kn.key.toString("hex")} nonce=${kn.nonce.toString("hex")}`);
        decrypted = eaxDecrypt(kn.key, kn.nonce, headerBytes, ciphertext, fullMac);
      } else if (this.dummyKey && this.dummyNonce) {
        usedKey = this.dummyKey; usedNonce = this.dummyNonce;
        console.log(`${ts()} [Voice] CMD decrypt dummy: pktId=${header.packetId} key=${this.dummyKey.toString("hex")} nonce=${this.dummyNonce.toString("hex")}`);
        decrypted = eaxDecrypt(this.dummyKey, this.dummyNonce, headerBytes, ciphertext, fullMac);
      }

      if (!decrypted) {
        console.error(
          `${ts()} [Voice] DECRYPT FAIL command pktId=${header.packetId} mode=${modeLabel}\n` +
          `  mac=${fullMac.toString("hex")}\n` +
          `  hdr=${headerBytes.toString("hex")}\n` +
          `  ct =${ciphertext.toString("hex")}\n` +
          `  key=${usedKey?.toString("hex") ?? "none"}\n` +
          `  non=${usedNonce?.toString("hex") ?? "none"}`
        );
        return;
      }
      console.log(`${ts()} [Voice] CMD decrypted OK (${modeLabel}) len=${decrypted.length}`);
      rawBytes = decrypted;
    }

    // Step 2: fragment reassembly — store raw bytes, NOT string
    // Compressed flag: only trust FIRST fragment or last piece (not middle fragments)
    if (header.flags & PacketFlags.Fragmented) {
      if (this.fragmentBuffer.size === 0) {
        // First fragment of new sequence — reset compressed from its flags
        this.fragmentCompressed = !!(header.flags & PacketFlags.Compressed);
      }
      this.fragmentBuffer.set(header.packetId, rawBytes);
      console.log(`${ts()} [Voice] Fragment pktId=${header.packetId} stored ${rawBytes.length}b (${this.fragmentBuffer.size} total, compressed=${this.fragmentCompressed})`);
      if (this.fragmentTimer) clearTimeout(this.fragmentTimer);
      this.fragmentTimer = setTimeout(() => {
        this.fragmentTimer = null;
        if (this.fragmentBuffer.size > 0) {
          const assembled = this.reassembleFragmentsRaw();
          const commandStr = this.qlzToString(assembled);
          this.fragmentCompressed = false;
          this.processServerCommand(commandStr);
        }
      }, 500);
      return;
    } else if (this.fragmentBuffer.size > 0) {
      if (header.flags & PacketFlags.Compressed) {
        // Standalone compressed command, NOT a fragment continuation.
        // Flush the pending (incomplete) fragments first, then process this packet separately.
        if (this.fragmentTimer) { clearTimeout(this.fragmentTimer); this.fragmentTimer = null; }
        const assembled = this.reassembleFragmentsRaw();
        const fragStr = this.qlzToString(assembled);
        this.fragmentCompressed = false;
        this.processServerCommand(fragStr);

        // Now process THIS packet as standalone compressed
        this.fragmentCompressed = true;
        const commandStr = this.qlzToString(rawBytes);
        this.fragmentCompressed = false;
        this.processServerCommand(commandStr);
        return;
      }
      // Last fragment (no Fragmented flag, no Compressed flag) — complete the assembly.
      if (this.fragmentTimer) { clearTimeout(this.fragmentTimer); this.fragmentTimer = null; }
      this.fragmentBuffer.set(header.packetId, rawBytes);
      const assembled = this.reassembleFragmentsRaw();
      const commandStr = this.qlzToString(assembled);
      this.fragmentCompressed = false;
      this.processServerCommand(commandStr);
      return;
    }

    // Single non-fragmented packet
    this.fragmentCompressed = !!(header.flags & PacketFlags.Compressed);
    const commandStr = this.qlzToString(rawBytes);
    this.fragmentCompressed = false;
    this.processServerCommand(commandStr);
  }

  /** Reassemble fragments in packetId order → raw Buffer */
  private reassembleFragmentsRaw(): Buffer {
    const keys = [...this.fragmentBuffer.keys()].sort((a, b) => a - b);
    const buffers = keys.map((k) => this.fragmentBuffer.get(k)!);
    const combined = Buffer.concat(buffers);
    this.fragmentBuffer.clear();
    console.log(`${ts()} [Voice] Fragments reassembled: ${keys.length} parts, ${combined.length}b raw (pktIds: ${keys.join(",")}) compressed=${this.fragmentCompressed}`);
    return combined;
  }

  /** Decompress with QuickLZ if fragmentCompressed, then return as UTF-8 string */
  private qlzToString(data: Buffer): string {
    if (!this.fragmentCompressed) return data.toString("utf-8");
    try {
      const qlz = new QuickLZ();
      const decompressed: Uint8Array = qlz.decompress(data, 0);
      const result = Buffer.from(decompressed).toString("utf-8");
      console.log(`${ts()} [Voice] QuickLZ decompressed ${data.length}b → ${decompressed.length}b`);
      return result;
    } catch (err) {
      console.error(`${ts()} [Voice] QuickLZ decompress FAILED: ${(err as Error).message} — falling back to raw UTF-8`);
      return data.toString("utf-8");
    }
  }

  private processServerCommand(cmd: string): void {
    const trimmed = cmd.trim();
    console.log(`${ts()} [Voice] CMD (${trimmed.length}b): ${trimmed.substring(0, 300)}`);

    // Try to discover clientId from ANY command (including garbled fragments)
    if (this.clientId === 0 && this.state === "connected") {
      this.tryExtractClientId(trimmed);
    }

    if (trimmed.startsWith("initivexpand2")) {
      this.handleInitivExpand2(trimmed);
    } else if (trimmed.startsWith("initivexpand ")) {
      this.handleInitivExpand(trimmed);
    } else if (trimmed.startsWith("initserver")) {
      this.handleInitServer(trimmed);
    } else if (trimmed.startsWith("notifycliententerview")) {
      this.handleClientEnterView(trimmed);
    } else if (trimmed.startsWith("notifytextmessage")) {
      this.handleTextMessage(trimmed);
    } else if (trimmed.startsWith("channellist ") || trimmed.startsWith("channellist|")) {
      this.handleChannelList(trimmed);
    } else if (trimmed.startsWith("channellistfinished")) {
      this.handleChannelListFinished();
    } else if (trimmed.startsWith("notifyclientchannelgroupchanged")) {
      this.handleClientChannelGroupChanged(trimmed);
    } else if (this.clientId === 0 && trimmed.startsWith("client_id=")) {
      this.handleWhoamiResponse(trimmed);
    } else if (trimmed.startsWith("error")) {
      this.handleError(trimmed);
    } else if (this.state === "crypto") {
      // In crypto state, any non-error response means the server
      // accepted our clientek. Proceed with clientinit.
      this.handleClientEkResponse(trimmed);
    }

    // Resolve pending commands
    for (const [id, handler] of this.pendingCommands) {
      if (trimmed.startsWith("error")) {
        const parsed = parseResponse(trimmed.replace("error ", ""));
        if (parsed[0]?.id === "0") {
          handler.resolve(trimmed);
        } else {
          handler.reject(
            new Error(`TS3 error ${parsed[0]?.id}: ${parsed[0]?.msg ?? "unknown"}`)
          );
        }
        this.pendingCommands.delete(id);
        break;
      }
    }
  }

  /**
   * Handle initivexpand2 (new protocol crypto setup).
   *
   * Key exchange: derive server's ephemeral Ed25519 key from license chain,
   * then X25519 DH for the shared secret.
   */
  private handleInitivExpand2(cmd: string): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);

    const parsed = parseResponse(cmd.replace("initivexpand2 ", ""));
    const data = parsed[0];
    if (!data) {
      console.error(`${ts()} [Voice] Empty initivexpand2 — no data parsed`);
      return;
    }

    console.log(`${ts()} [Voice] initivexpand2 params: ${Object.keys(data).join(", ")}`);
    for (const [k, v] of Object.entries(data)) {
      console.log(`${ts()} [Voice]   ${k}(${v.length}): ${v.substring(0, 80)}${v.length > 80 ? "..." : ""}`);
    }

    const betaB64 = data.beta;
    const licenseB64 = data.l;

    if (!betaB64 || !licenseB64) {
      console.error(`${ts()} [Voice] MISSING beta=${!!betaB64} l=${!!licenseB64} in initivexpand2`);
      return;
    }

    const beta = Buffer.from(betaB64, "base64");
    const licenseData = Buffer.from(licenseB64, "base64");

    console.log(`${ts()} [Voice] beta(${beta.length}b)=${beta.toString("hex")} license=${licenseData.length}b`);

    try {
      // 1. Parse license chain and derive server's Ed25519 public key (accumulated)
      const blocks = parseLicenseChain(licenseData);
      console.log(`${ts()} [Voice] License chain: ${blocks.length} blocks`);
      if (blocks.length === 0) throw new Error("Empty license chain");

      const serverEd25519Pub = deriveLicenseKey(blocks);
      console.log(`${ts()} [Voice] Server Ed25519 derived key: ${Buffer.from(serverEd25519Pub).toString("hex")}`);

      // 2. Generate ephemeral Edwards25519 keypair using a clamped random scalar
      const Point = ed25519.Point;
      const scalarBytes = crypto.randomBytes(32);
      scalarBytes[0] &= 248;
      scalarBytes[31] &= 127;
      scalarBytes[31] |= 64;
      let scalar = bytesToBigIntLE(scalarBytes) % ED25519_N;
      if (scalar === 0n) scalar = 1n;
      console.log(`${ts()} [Voice] Scalar (clamped LE): ${scalarBytes.toString("hex")}`);

      const ekPub = Point.BASE.multiply(scalar).toBytes();
      this.ekPubBytes = ekPub;
      console.log(`${ts()} [Voice] Client ekPub (Ed25519): ${Buffer.from(ekPub).toString("hex")}`);

      // 3. Edwards ECDH: shared_secret = compress(server_point * scalar)
      const serverPoint = Point.fromHex(Buffer.from(serverEd25519Pub).toString("hex"));
      const sharedSecret = serverPoint.multiply(scalar).toBytes();
      console.log(`${ts()} [Voice] Shared secret (Edwards): ${Buffer.from(sharedSecret).toString("hex")}`);

      // 4. SharedIV = SHA-512(sharedSecret), then XOR alpha[0..10] and beta[0..54]
      const sharedIVraw = deriveSharedIV(Buffer.from(sharedSecret));
      console.log(`${ts()} [Voice] SHA-512(sharedSecret)[0..63]: ${sharedIVraw.toString("hex")}`);
      console.log(`${ts()} [Voice] alpha (10b): ${this.alpha.toString("hex")}`);
      console.log(`${ts()} [Voice] beta  (${beta.length}b): ${beta.toString("hex")}`);
      const sharedIV = sharedIVraw;
      for (let i = 0; i < 10; i++) sharedIV[i] ^= this.alpha[i];
      for (let i = 0; i < 54 && 10 + i < 64; i++) sharedIV[10 + i] ^= beta[i];
      console.log(`${ts()} [Voice] sharedIV (after XOR): ${sharedIV.toString("hex")}`);

      this.pendingSharedIV = sharedIV;
      this.dummyKey = DUMMY_KEY;
      this.dummyNonce = DUMMY_NONCE;
      this.encrypted = true;

      this.setState("crypto");
      this.sendClientEk(beta);
    } catch (err) {
      console.error(`${ts()} [Voice] Crypto setup FAILED: ${(err as Error).message}\n${(err as Error).stack}`);
      this.encrypted = false;
      this.setState("connecting");
      this.sendClientInit();
    }
  }

  /**
   * Send clientek command for ot=1 new protocol.
   * Generates an X25519 keypair, signs the public key with our P-256 identity,
   * and sends it to the server encrypted with the temporary session keys.
   */
  private sendClientEk(beta: Buffer): void {
    if (!this.ekPubBytes) {
      console.error(`${ts()} [Voice] No Ed25519 public key for clientek — ekPubBytes is null`);
      return;
    }

    // ek = Ed25519 public key (32 bytes)
    const ekRaw = Buffer.from(this.ekPubBytes);

    // proof = ECDSA-P256-SHA256 sign(concat(ekPub, fullBeta))
    const proofData = Buffer.concat([ekRaw, beta]);
    const identityKeyObj = this.getIdentityKeyObject();
    const proof = crypto.sign("SHA256", proofData, identityKeyObj);

    const ekB64 = ekRaw.toString("base64");
    const proofB64 = proof.toString("base64");

    console.log(`${ts()} [Voice] clientek ek(${ekRaw.length}b): ${ekRaw.toString("hex")}`);
    console.log(`${ts()} [Voice] clientek proofData(ek+beta, ${proofData.length}b): ${proofData.toString("hex")}`);
    console.log(`${ts()} [Voice] clientek proof(DER sig, ${proof.length}b): ${proof.toString("hex")}`);

    const cmd = `clientek ek=${ts3escape(ekB64)} proof=${ts3escape(proofB64)}`;
    console.log(`${ts()} [Voice] clientek cmd (${cmd.length}b): ${cmd.substring(0, 200)}`);
    this.clientEkPacketId = this.commandCounter;
    console.log(`${ts()} [Voice] clientEkPacketId=${this.clientEkPacketId}`);
    this.sendCommandRaw(cmd);

    this.connectionTimeout = setTimeout(() => {
      if (this.state === "crypto") {
        console.log(`${ts()} [Voice] clientek timeout (10s) — no ACK received. clientEkPacketId=${this.clientEkPacketId}`);
        this.setState("connecting");
        this.sendClientInit();
      }
    }, 10000);
  }

  /** Create a Node.js KeyObject from our raw P-256 private key for ECDSA signing */
  private getIdentityKeyObject(): crypto.KeyObject {
    // PKCS#8 DER prefix for EC P-256 private key (before the 32 raw key bytes)
    const pkcs8Prefix = Buffer.from(
      "3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420",
      "hex"
    );
    const der = Buffer.concat([pkcs8Prefix, this.identity.privateKey]);
    return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  }

  /**
   * Handle server's response after clientek.
   * For ot=1, the server might respond with initserver directly,
   * or with an error, or with nothing (and just accept the clientek
   * as sufficient to start the session).
   */
  private handleClientEkResponse(cmd: string): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);

    console.log(`${ts()} [Voice] Response in crypto state: ${cmd.substring(0,80)}`);

    // The server might respond with initserver directly
    // or with an error. Either way, proceed.
    if (cmd.startsWith("initserver")) {
      this.handleInitServer(cmd);
      return;
    }

    // Try to handle as error
    if (cmd.startsWith("error")) {
      this.handleError(cmd);
      return;
    }

    console.log(`${ts()} [Voice] Unexpected cmd after clientek (state=crypto): ${cmd.substring(0, 80)}`);
    this.setState("connecting");
    this.sendClientInit();
  }

  /** Handle initivexpand (old protocol) — not supported, only ot=1 used */
  private handleInitivExpand(_cmd: string): void {
    console.error(`${ts()} [Voice] Old protocol (initivexpand) received — server must use ot=1`);
    this.emit("error", new Error("Old protocol not supported"));
  }

  private sendClientInit(): void {
    const params: Record<string, string | number> = {
      client_nickname: this.options.nickname,
      client_version: CLIENT_VERSION.version,
      client_platform: CLIENT_VERSION.platform,
      client_version_sign: CLIENT_VERSION.sign,
      client_key_offset: this.identity.keyOffset,
      client_input_hardware: 1,
      client_output_hardware: 1,
      client_default_channel: this.options.channel,
      client_meta_data: "",
      client_nickname_phonetic: "",
      client_default_token: "",
      hwid: HWID,
    };

    if (this.options.serverPassword) {
      params.client_server_password = this.options.serverPassword;
    }

    const cmd = buildCommand("clientinit", params);
    const encMode = this.sharedIV ? `real(sharedIV=${this.sharedIV.subarray(0,8).toString("hex")}...)` : (this.dummyKey ? "dummy" : "NONE");
    console.log(`${ts()} [Voice] Sending clientinit pktId=${this.commandCounter} enc=${encMode}`);
    this.sendCommandRaw(cmd);

    this.connectionTimeout = setTimeout(() => {
      if (this.state === "connecting") {
        console.log(`${ts()} [Voice] clientinit timeout — no initserver after 10s`);
        this.emit("error", new Error("clientinit timeout"));
      }
    }, 10000);
  }

  private handleInitServer(cmd: string): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);

    // Ignore retransmissions — only process the first initserver
    if (this.state === "connected") {
      console.log(`${ts()} [Voice] initserver retransmission ignored (already connected)`);
      return;
    }

    const parsed = parseResponse(cmd.replace("initserver ", ""));
    if (parsed[0]) {
      // Try aclid first, then clid as fallback (TeaSpeak compat)
      const aclid = parsed[0].aclid ?? parsed[0].clid ?? "0";
      const parsedId = parseInt(aclid, 10);
      if (parsedId > 0) {
        this.clientId = parsedId;
      }
      console.log(`${ts()} [Voice] initserver: server="${parsed[0].virtualserver_name ?? "?"}" clientId=${this.clientId} aclid=${parsed[0].aclid ?? "MISSING"} welcomemsg="${(parsed[0].virtualserver_welcomemessage ?? "").substring(0,60)}"`);
      if (this.clientId === 0) {
        console.warn(`${ts()} [Voice] WARNING: clientId=0 from initserver — will get from notifycliententerview`);
      }
    }

    this.setState("connected");

    // Start keep-alive pings
    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, 5000);

    this.emit("connected");

    // TeaSpeak doesn't include aclid in initserver — send whoami to get our clientId
    if (this.clientId === 0) {
      console.log(`${ts()} [Voice] clientId=0 after initserver, sending whoami to discover it`);
      this.sendCommandRaw("whoami");
    }
  }

  private handleChannelList(cmd: string): void {
    // channellist cid=1 channel_name=Lobby ...|cid=2 channel_name=TendroAudio ...
    const raw = cmd.startsWith("channellist|") ? cmd.substring("channellist".length) : cmd.substring("channellist ".length);
    const entries = parseResponse(raw);
    for (const entry of entries) {
      const name = entry.channel_name ?? "";
      const cid = entry.cid ?? "";
      if (name === this.options.channel) {
        this.targetChannelId = parseInt(cid, 10);
        console.log(`${ts()} [Voice] Found target channel "${name}" cid=${this.targetChannelId}`);
      }
    }
  }

  private handleChannelListFinished(): void {
    console.log(`${ts()} [Voice] channellistfinished — targetChannelId=${this.targetChannelId}`);
    if (this.targetChannelId >= 0 && this.clientId > 0) {
      console.log(`${ts()} [Voice] Moving to channel "${this.options.channel}" (cid=${this.targetChannelId})...`);
      this.sendCommandRaw(buildCommand("clientmove", {
        clid: this.clientId,
        cid: this.targetChannelId,
      }));
    } else if (this.targetChannelId < 0) {
      console.warn(`${ts()} [Voice] Target channel "${this.options.channel}" not found in channel list`);
    }
  }

  private handleTextMessage(cmd: string): void {
    const parsed = parseResponse(cmd.replace("notifytextmessage ", ""));
    const data = parsed[0];
    if (!data) return;

    const targetmode = parseInt(data.targetmode ?? "0", 10);
    const msg = data.msg ?? "";
    const invokerName = data.invokername ?? "";

    // Only channel messages (targetmode=2)
    if (targetmode !== 2) return;

    console.log(`${ts()} [Voice] Text from ${invokerName}: ${msg}`);
    this.emit("textmessage", { msg, invokerName, targetmode });
  }

  /** Send a text message to the current channel via voice protocol */
  sendTextMessage(msg: string): void {
    if (this.state !== "connected") return;
    const cmd = buildCommand("sendtextmessage", {
      targetmode: 2,
      msg,
    });
    this.sendCommandRaw(cmd);
  }

  private handleClientEnterView(cmd: string): void {
    const entries = parseResponse(cmd.replace("notifycliententerview ", ""));
    for (const entry of entries) {
      if (entry.client_nickname === this.options.nickname) {
        const clid = parseInt(entry.clid ?? "0", 10);
        if (clid > 0) {
          console.log(`${ts()} [Voice] Found our clientId=${clid} from notifycliententerview (was ${this.clientId})`);
          this.clientId = clid;
        }
      }
    }
  }

  /** Scan any command (including garbled fragments) for clientId patterns */
  private tryExtractClientId(cmd: string): void {
    const lower = cmd.toLowerCase();
    const nickname = this.options.nickname.toLowerCase();
    const partial = nickname.length > 7 ? nickname.slice(-7) : nickname;

    // Method 1: clean clid=XX with our nickname nearby
    const match = cmd.match(/clid=(\d+)/);
    if (match && (lower.includes(nickname) || lower.includes(partial))) {
      const clid = parseInt(match[1], 10);
      if (clid > 0) {
        console.log(`${ts()} [Voice] Extracted clientId=${clid} from command (nickname match)`);
        this.clientId = clid;
        return;
      }
    }

    // Method 2: garbled notifycliententerview fragment from TeaSpeak.
    // Pattern: orphaned fragment contains TS3 permission fields (talk_power,
    // query_view_power, badged) and "d=XX" which is the garbled "clid=XX".
    // The bot's nickname is in a DIFFERENT fragment so we can't cross-reference.
    if (lower.includes("lk_power") || lower.includes("ery_view_power")) {
      const bareMatch = cmd.match(/\bd=(\d{1,5})\s/);
      if (bareMatch) {
        const clid = parseInt(bareMatch[1], 10);
        if (clid > 0 && clid < 65535) {
          console.log(`${ts()} [Voice] Extracted clientId=${clid} from garbled fragment (d=XX near permission fields)`);
          this.clientId = clid;
        }
      }
    }
  }

  private handleWhoamiResponse(cmd: string): void {
    const parsed = parseResponse(cmd);
    const data = parsed[0];
    if (!data) return;
    const clid = parseInt(data.client_id ?? "0", 10);
    if (clid > 0) {
      console.log(`${ts()} [Voice] Got clientId=${clid} from whoami (was ${this.clientId})`);
      this.clientId = clid;
      // If we know the target channel but couldn't move earlier (clientId was 0), do it now
      if (this.targetChannelId >= 0) {
        console.log(`${ts()} [Voice] Now moving to channel "${this.options.channel}" (cid=${this.targetChannelId})...`);
        this.sendCommandRaw(buildCommand("clientmove", {
          clid: this.clientId,
          cid: this.targetChannelId,
        }));
      }
    }
  }

  private handleClientChannelGroupChanged(cmd: string): void {
    // Fallback clientId source: notifyclientchannelgroupchanged clid=XX cid=YY ...
    // Only use if we still don't have our clientId
    if (this.clientId > 0) return;
    const parsed = parseResponse(cmd.replace("notifyclientchannelgroupchanged ", ""));
    const data = parsed[0];
    if (!data) return;
    const clid = parseInt(data.clid ?? "0", 10);
    const cid = parseInt(data.cid ?? "0", 10);
    // If cid matches our target channel, it's very likely us (we just joined)
    if (clid > 0 && cid === this.targetChannelId) {
      console.log(`${ts()} [Voice] Got clientId=${clid} from notifyclientchannelgroupchanged (cid=${cid} matches target)`);
      this.clientId = clid;
    }
  }

  private handleError(cmd: string): void {
    const parsed = parseResponse(cmd.replace("error ", ""));
    const errorId = parsed[0]?.id ?? "0";
    const errorMsg = parsed[0]?.msg ?? "ok";

    if (errorId === "0") return; // "ok"

    console.error(`${ts()} [Voice] Server error id=${errorId} msg="${errorMsg}" state=${this.state}`);

    if (this.state === "connecting") {
      this.emit(
        "error",
        new Error(`Connection rejected: ${errorMsg} (${errorId})`)
      );
    }
  }

  private handlePingPacket(header: { packetId: number }): void {
    if (this.encrypted && this.sharedIV) {
      // Encrypted Pong
      const hdr = Buffer.alloc(5);
      hdr.writeUInt16BE(header.packetId, 0);
      hdr.writeUInt16BE(this.clientId, 2);
      hdr[4] = (PacketFlags.NewProtocol & 0xf0) | (PacketType.Pong & 0x0f);

      const { key, nonce } = derivePacketKeyNonce(this.sharedIV, "c2s", PacketType.Pong, this.generationId, header.packetId);
      const { ciphertext, mac } = eaxEncrypt(key, nonce, hdr, Buffer.alloc(0));
      const packet = Buffer.alloc(13 + ciphertext.length);
      mac.copy(packet, 0, 0, 8);
      hdr.copy(packet, 8);
      ciphertext.copy(packet, 13);
      this.send(packet);
    } else {
      const pong = encodePong(header.packetId, this.clientId);
      this.send(pong);
    }
  }

  private handleAckPacket(
    header: { packetId: number; flags: number; type: number },
    payload: Buffer,
    raw: Buffer
  ): void {
    let ackPayload: Buffer;

    if (header.flags & PacketFlags.Unencrypted) {
      ackPayload = payload;
      console.log(`${ts()} [Voice] ACK unencrypted payload: ${payload.toString("hex")}`);
    } else {
      const mac = raw.subarray(0, 8);
      const fullMac = Buffer.alloc(16);
      mac.copy(fullMac, 0);
      const headerBytes = raw.subarray(8, 11);
      const ciphertext = raw.subarray(11);
      const modeLabel = this.sharedIV ? "real" : (this.dummyKey ? "dummy" : "none");
      let usedKey: Buffer | null = null;
      let usedNonce: Buffer | null = null;
      let decrypted: Buffer | null = null;

      if (this.sharedIV) {
        const kn = derivePacketKeyNonce(this.sharedIV, "s2c", header.type, this.generationId, header.packetId);
        usedKey = kn.key; usedNonce = kn.nonce;
        console.log(`${ts()} [Voice] ACK decrypt real: pktId=${header.packetId} key=${kn.key.toString("hex")} nonce=${kn.nonce.toString("hex")}`);
        decrypted = eaxDecrypt(kn.key, kn.nonce, headerBytes, ciphertext, fullMac);
      } else if (this.dummyKey && this.dummyNonce) {
        usedKey = this.dummyKey; usedNonce = this.dummyNonce;
        console.log(`${ts()} [Voice] ACK decrypt dummy: pktId=${header.packetId} key=${this.dummyKey.toString("hex")} nonce=${this.dummyNonce.toString("hex")}`);
        decrypted = eaxDecrypt(this.dummyKey, this.dummyNonce, headerBytes, ciphertext, fullMac);
      } else {
        console.warn(`${ts()} [Voice] ACK pktId=${header.packetId} — no decryption key available (state=${this.state})`);
      }

      if (!decrypted) {
        console.error(
          `${ts()} [Voice] DECRYPT FAIL ACK pktId=${header.packetId} mode=${modeLabel}\n` +
          `  mac=${fullMac.toString("hex")}\n` +
          `  hdr=${headerBytes.toString("hex")}\n` +
          `  ct =${ciphertext.toString("hex")}\n` +
          `  key=${usedKey?.toString("hex") ?? "none"}\n` +
          `  non=${usedNonce?.toString("hex") ?? "none"}`
        );
        return;
      }
      console.log(`${ts()} [Voice] ACK decrypted OK (${modeLabel}): ${decrypted.toString("hex")}`);
      ackPayload = decrypted;
    }

    if (ackPayload.length >= 2) {
      const ackedId = ackPayload.readUInt16BE(0);
      console.log(`${ts()} [Voice] ACK ackedId=${ackedId} clientEkPacketId=${this.clientEkPacketId} state=${this.state}`);

      if (this.state === "crypto" && ackedId === this.clientEkPacketId) {
        console.log(`${ts()} [Voice] clientek ACK matched — activating real encryption`);
        if (this.connectionTimeout) clearTimeout(this.connectionTimeout);

        this.sharedIV = this.pendingSharedIV;
        this.pendingSharedIV = null;
        this.dummyKey = null;
        this.dummyNonce = null;
        console.log(`${ts()} [Voice] sharedIV active: ${this.sharedIV!.toString("hex")}`);

        this.setState("connecting");
        this.sendClientInit();
      }
    }
  }

  // ========================================================
  // Sending
  // ========================================================

  private send(data: Buffer): void {
    if (!this.socket) return;
    if (this.state !== "connected") {
      console.log(`${ts()} [Voice] SEND ${data.length}b raw: ${data.toString("hex")}`);
    }
    this.socket.send(data, this.options.port, this.options.host, (err) => {
      if (err) console.error(`${ts()} [Voice] Send error: ${err.message}`);
    });
  }

  private sendAck(packetId: number): void {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(packetId, 0);

    if (this.encrypted && this.sharedIV) {
      // Encrypted ACK: MAC(8) + Header(5) + Ciphertext
      const header = Buffer.alloc(5);
      header.writeUInt16BE(packetId, 0);
      header.writeUInt16BE(this.clientId, 2);
      header[4] = (PacketFlags.NewProtocol & 0xf0) | (PacketType.Ack & 0x0f);

      const { key, nonce } = derivePacketKeyNonce(this.sharedIV, "c2s", PacketType.Ack, this.generationId, packetId);
      const { ciphertext, mac } = eaxEncrypt(key, nonce, header, payload);
      const packet = Buffer.alloc(13 + ciphertext.length);
      mac.copy(packet, 0, 0, 8);
      header.copy(packet, 8);
      ciphertext.copy(packet, 13);
      this.send(packet);
    } else {
      const ack = encodeAck(packetId, this.clientId);
      this.send(ack);
    }
  }

  private sendPing(): void {
    const pingId = this.pingCounter++ & 0xffff;

    if (this.encrypted && this.sharedIV) {
      // Encrypted Ping: MAC(8) + Header(5) + Ciphertext (empty payload)
      const header = Buffer.alloc(5);
      header.writeUInt16BE(pingId, 0);
      header.writeUInt16BE(this.clientId, 2);
      header[4] = (PacketFlags.NewProtocol & 0xf0) | (PacketType.Ping & 0x0f);

      const { key, nonce } = derivePacketKeyNonce(this.sharedIV, "c2s", PacketType.Ping, this.generationId, pingId);
      const { ciphertext, mac } = eaxEncrypt(key, nonce, header, Buffer.alloc(0));
      const packet = Buffer.alloc(13 + ciphertext.length);
      mac.copy(packet, 0, 0, 8);
      header.copy(packet, 8);
      ciphertext.copy(packet, 13);
      this.send(packet);
    } else {
      const ping = encodePing(pingId, this.clientId);
      this.send(ping);
    }
  }

  private sendCommandRaw(command: string): void {
    const packetId = this.commandCounter++ & 0xffff;
    const payload = Buffer.from(command, "utf-8");

    // Build 5-byte C→S header for EAX AAD: [PacketId:2][ClientId:2][FlagsType:1]
    const header = Buffer.alloc(5);
    header.writeUInt16BE(packetId, 0);
    header.writeUInt16BE(this.clientId, 2);
    header[4] = (PacketFlags.NewProtocol & 0xf0) | (PacketType.Command & 0x0f);

    const cmdPreview = command.substring(0, 120);
    console.log(`${ts()} [Voice] SENDCMD pktId=${packetId} clientId=${this.clientId} len=${payload.length}: ${cmdPreview}`);

    if (this.encrypted && this.sharedIV) {
      const { key, nonce } = derivePacketKeyNonce(this.sharedIV, "c2s", PacketType.Command, this.generationId, packetId);
      console.log(`${ts()} [Voice] SENDCMD real: key=${key.toString("hex")} nonce=${nonce.toString("hex")} AAD=${header.toString("hex")}`);
      const { ciphertext, mac } = eaxEncrypt(key, nonce, header, payload);
      const packet = Buffer.alloc(13 + ciphertext.length);
      mac.copy(packet, 0, 0, 8);
      header.copy(packet, 8);
      ciphertext.copy(packet, 13);
      this.send(packet);
    } else if (this.encrypted && this.dummyKey && this.dummyNonce) {
      console.log(`${ts()} [Voice] SENDCMD dummy: key=${this.dummyKey.toString("hex")} nonce=${this.dummyNonce.toString("hex")} AAD=${header.toString("hex")}`);
      const { ciphertext, mac } = eaxEncrypt(this.dummyKey, this.dummyNonce, header, payload);
      const packet = Buffer.alloc(13 + ciphertext.length);
      mac.copy(packet, 0, 0, 8);
      header.copy(packet, 8);
      ciphertext.copy(packet, 13);
      this.send(packet);
    } else {
      console.log(`${ts()} [Voice] SENDCMD unencrypted`);
      const packet = encodePacket(PacketType.Command, payload, packetId, this.clientId, PacketFlags.Unencrypted | PacketFlags.NewProtocol);
      this.send(packet);
    }
  }

  sendCommand(
    name: string,
    params: Record<string, string | number>
  ): Promise<string> {
    const cmd = buildCommand(name, params);
    const packetId = this.commandCounter; // Will be incremented in sendCommandRaw

    return new Promise((resolve, reject) => {
      this.pendingCommands.set(packetId, { resolve, reject });
      this.sendCommandRaw(cmd);

      setTimeout(() => {
        if (this.pendingCommands.has(packetId)) {
          this.pendingCommands.delete(packetId);
          reject(new Error(`Command timeout: ${name}`));
        }
      }, 10000);
    });
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  getState(): VoiceClientState {
    return this.state;
  }
}
