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
  encodeVoicePacket,
} from "./packet";
import {
  eaxEncrypt,
  eaxDecrypt,
  generateECDH,
  computeSharedSecret,
  deriveKeys,
  generatePacketNonce,
} from "./crypto";
import { generateIdentity, TS3Identity } from "./identity";

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
  | "init1"
  | "init2"
  | "init3"
  | "connecting"
  | "connected"
  | "disconnecting";

export class VoiceClient extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private state: VoiceClientState = "disconnected";
  private options: VoiceClientOptions;
  private identity: TS3Identity;

  // Packet counters
  private commandCounter = 0;
  private voiceCounter = 0;
  private pingCounter = 0;
  private generationId = 0;

  // Connection state
  private clientId = 0;
  private encryptionKey: Buffer | null = null;
  private encryptionNonce: Buffer | null = null;
  private encrypted = false;

  // Handshake state
  private initRandom = Buffer.alloc(0);
  private serverCookie = Buffer.alloc(0);

  // Keep-alive
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;

  // Pending command responses
  private pendingCommands: Map<
    number,
    { resolve: (data: string) => void; reject: (err: Error) => void }
  > = new Map();

  // Fragment reassembly
  private fragmentBuffer: Buffer[] = [];

  constructor(options: VoiceClientOptions) {
    super();
    this.options = options;
    this.identity = options.identity ?? generateIdentity(8);
    console.log(
      `[Voice] Generated identity with security level ${this.identity.securityLevel}`
    );
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket("udp4");

      this.socket.on("message", (msg) => this.handlePacket(msg));
      this.socket.on("error", (err) => {
        console.error("[Voice] Socket error:", err.message);
        this.emit("error", err);
      });

      this.socket.bind(0, () => {
        console.log(
          `[Voice] Connecting to ${this.options.host}:${this.options.port}...`
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
    this.state = "disconnecting";
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);

    // Send disconnect command
    if (this.socket) {
      try {
        this.sendCommand("clientdisconnect", {
          reasonid: "8",
          reasonmsg: "leaving",
        });
      } catch {
        // Ignore send errors during disconnect
      }
    }

    setTimeout(() => {
      this.socket?.close();
      this.socket = null;
      this.state = "disconnected";
      this.encrypted = false;
      this.encryptionKey = null;
      this.encryptionNonce = null;
      this.emit("disconnected");
    }, 200);
  }

  /** Send an Opus voice frame */
  sendVoice(opusData: Buffer): void {
    if (this.state !== "connected" || !this.socket) return;

    const packetId = this.voiceCounter++ & 0xffff;

    if (this.encrypted && this.encryptionKey && this.encryptionNonce) {
      // Build unencrypted packet first to get header bytes
      const voicePayload = Buffer.alloc(5 + opusData.length);
      voicePayload.writeUInt16BE(packetId, 0);
      voicePayload[2] = Codec.OpusMusic;
      // Opus frame size (2 bytes big endian) + data
      voicePayload.writeUInt16BE(opusData.length, 3);
      opusData.copy(voicePayload, 5);

      const header = Buffer.alloc(5);
      header.writeUInt16BE(packetId, 0); // packet id
      header.writeUInt16BE(this.clientId, 2); // client id
      header[4] = PacketType.Voice; // type + flags

      const nonce = generatePacketNonce(
        this.encryptionNonce,
        this.generationId,
        packetId,
        false
      );

      const { ciphertext, mac } = eaxEncrypt(
        this.encryptionKey,
        nonce,
        header,
        voicePayload
      );

      const packet = Buffer.alloc(13 + ciphertext.length);
      mac.copy(packet, 0, 0, 8); // First 8 bytes of MAC
      header.copy(packet, 8);
      ciphertext.copy(packet, 13);

      this.send(packet);
    } else {
      // Unencrypted voice
      const voicePayload = Buffer.alloc(5 + opusData.length);
      voicePayload.writeUInt16BE(packetId, 0);
      voicePayload[2] = Codec.OpusMusic;
      voicePayload.writeUInt16BE(opusData.length, 3);
      opusData.copy(voicePayload, 5);

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

    // Empty voice packet signals stop
    const voicePayload = Buffer.alloc(5);
    voicePayload.writeUInt16BE(packetId, 0);
    voicePayload[2] = Codec.OpusMusic;
    voicePayload.writeUInt16BE(0, 3); // 0 length = stop

    const packet = encodePacket(
      PacketType.Voice,
      voicePayload,
      packetId,
      this.clientId,
      PacketFlags.Unencrypted
    );
    this.send(packet);
  }

  // ---- Init Handshake ----

  private sendInit0(): void {
    this.state = "init0";
    this.initRandom = crypto.randomBytes(4);

    // Init step 0: [version(4)][random(4)][timestamp(4)][zeros(8)][step(1)]
    const payload = Buffer.alloc(21);
    // TS3 init version
    payload.writeUInt32BE(0x09, 0); // Init version
    payload.writeUInt32BE(Math.floor(Date.now() / 1000), 4); // Timestamp
    this.initRandom.copy(payload, 8); // Random
    payload.fill(0, 12, 20); // Reserved zeros
    payload[20] = 0; // Step 0

    const packet = encodePacket(
      PacketType.Init,
      payload,
      101,
      0,
      PacketFlags.Unencrypted
    );
    this.send(packet);

    // Retry after timeout
    this.connectionTimeout = setTimeout(() => {
      if (this.state === "init0") {
        console.log("[Voice] Init0 timeout, retrying...");
        this.sendInit0();
      }
    }, 5000);
  }

  private handleInit1Response(payload: Buffer): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    this.state = "init1";

    // Step 1 response contains: [random(16)][cookie data...]
    // Extract the cookie/challenge from server
    this.serverCookie = Buffer.from(payload.subarray(1)); // Skip step byte

    // Send init step 2
    this.sendInit2();
  }

  private sendInit2(): void {
    this.state = "init2";

    // Init step 2: echo back server's data with step=2
    const payload = Buffer.alloc(1 + this.serverCookie.length);
    payload[0] = 2; // Step 2
    this.serverCookie.copy(payload, 1);

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
        console.log("[Voice] Init2 timeout, retrying...");
        this.sendInit2();
      }
    }, 5000);
  }

  private handleInit3Response(payload: Buffer): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    this.state = "init3";

    // Step 3 response contains server's crypto parameters
    // Extract the server's ECDH public key (last 65 bytes for uncompressed P-256)
    const data = payload.subarray(1); // Skip step byte

    // The data format varies, but typically includes:
    // - Server's ECDH public key (65 bytes, uncompressed)
    // - Various server parameters
    // Try to find the ECDH public key (starts with 0x04 for uncompressed)

    let serverPublicKey: Buffer | null = null;

    // Search for uncompressed EC point marker (0x04) followed by 64 bytes
    for (let i = 0; i <= data.length - 65; i++) {
      if (data[i] === 0x04) {
        serverPublicKey = data.subarray(i, i + 65);
        break;
      }
    }

    if (serverPublicKey) {
      try {
        const ecdh = generateECDH();
        const sharedSecret = computeSharedSecret(ecdh, serverPublicKey);
        const { key, nonce } = deriveKeys(sharedSecret);
        this.encryptionKey = key;
        this.encryptionNonce = nonce;

        console.log("[Voice] Crypto handshake completed");

        // Send clientinit
        this.sendClientInit(ecdh.getPublicKey());
      } catch (err) {
        console.warn(
          "[Voice] Crypto setup failed, continuing unencrypted:",
          (err as Error).message
        );
        this.sendClientInit(null);
      }
    } else {
      console.log("[Voice] No server public key found, continuing unencrypted");
      this.sendClientInit(null);
    }
  }

  private sendClientInit(ourPublicKey: Buffer | null): void {
    this.state = "connecting";

    const params: Record<string, string | number> = {
      client_nickname: this.options.nickname,
      client_version: CLIENT_VERSION.version,
      client_platform: CLIENT_VERSION.platform,
      client_version_sign: CLIENT_VERSION.sign,
      client_key_offset: this.identity.keyOffset,
      client_input_hardware: 1,
      client_output_hardware: 1,
      client_default_channel: `/${this.options.channel}`,
      client_meta_data: "",
      client_nickname_phonetic: "",
      client_default_token: "",
      hwid: HWID,
    };

    if (this.options.serverPassword) {
      params.client_server_password = this.options.serverPassword;
    }

    const cmd = buildCommand("clientinit", params);
    this.sendCommandRaw(cmd);

    this.connectionTimeout = setTimeout(() => {
      if (this.state === "connecting") {
        console.log("[Voice] clientinit timeout");
        this.emit("error", new Error("clientinit timeout"));
      }
    }, 10000);
  }

  // ---- Packet Handling ----

  private handlePacket(data: Buffer): void {
    try {
      const packet = decodePacket(data);
      const { header, payload } = packet;

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
          // Pong received, connection alive
          break;

        case PacketType.Ack:
          this.handleAckPacket(payload);
          break;

        case PacketType.AckLow:
          this.handleAckPacket(payload);
          break;

        case PacketType.Voice:
        case PacketType.VoiceWhisper:
          // We receive voice from others; ignore
          break;

        default:
          break;
      }
    } catch (err) {
      console.error(
        "[Voice] Error handling packet:",
        (err as Error).message
      );
    }
  }

  private handleInitPacket(payload: Buffer): void {
    if (payload.length === 0) return;
    const step = payload[0];

    switch (step) {
      case 1:
        this.handleInit1Response(payload);
        break;
      case 3:
        this.handleInit3Response(payload);
        break;
      default:
        console.log(`[Voice] Unknown init step: ${step}`);
    }
  }

  private handleCommandPacket(
    header: { packetId: number; flags: number },
    payload: Buffer,
    raw: Buffer
  ): void {
    let commandStr: string;

    if (header.flags & PacketFlags.Unencrypted) {
      commandStr = payload.toString("utf-8");
    } else if (this.encryptionKey && this.encryptionNonce) {
      // Decrypt
      const mac = raw.subarray(0, 8);
      const fullMac = Buffer.alloc(16);
      mac.copy(fullMac, 0);
      const headerBytes = raw.subarray(8, 13);
      const ciphertext = raw.subarray(13);
      const nonce = generatePacketNonce(
        this.encryptionNonce,
        this.generationId,
        header.packetId,
        true
      );
      const decrypted = eaxDecrypt(
        this.encryptionKey,
        nonce,
        headerBytes,
        ciphertext,
        fullMac
      );
      if (!decrypted) {
        console.warn("[Voice] Failed to decrypt command packet");
        return;
      }
      commandStr = decrypted.toString("utf-8");
    } else {
      commandStr = payload.toString("utf-8");
    }

    // Send ACK
    this.sendAck(header.packetId);

    // Handle fragmented packets
    if (header.flags & PacketFlags.Fragmented) {
      this.fragmentBuffer.push(Buffer.from(commandStr, "utf-8"));
      return;
    } else if (this.fragmentBuffer.length > 0) {
      this.fragmentBuffer.push(Buffer.from(commandStr, "utf-8"));
      commandStr = Buffer.concat(this.fragmentBuffer).toString("utf-8");
      this.fragmentBuffer = [];
    }

    // Process the command response
    this.processServerCommand(commandStr);
  }

  private processServerCommand(cmd: string): void {
    const trimmed = cmd.trim();

    if (trimmed.startsWith("initserver")) {
      this.handleInitServer(trimmed);
    } else if (trimmed.startsWith("notifychannellist") || trimmed.startsWith("channellist")) {
      // Channel list received during connection, ignore
    } else if (trimmed.startsWith("notifycliententerview")) {
      // Client entered - could be us
    } else if (trimmed.startsWith("notifytextmessage")) {
      this.handleTextMessage(trimmed);
    } else if (trimmed.startsWith("error")) {
      this.handleError(trimmed);
    }

    // Resolve pending commands
    for (const [id, handler] of this.pendingCommands) {
      if (trimmed.startsWith("error")) {
        const parsed = parseResponse(trimmed.replace("error ", ""));
        if (parsed[0]?.id === "0") {
          handler.resolve(trimmed);
        } else {
          handler.reject(
            new Error(
              `TS3 error ${parsed[0]?.id}: ${parsed[0]?.msg ?? "unknown"}`
            )
          );
        }
        this.pendingCommands.delete(id);
        break;
      }
    }
  }

  private handleInitServer(cmd: string): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);

    const parsed = parseResponse(cmd.replace("initserver ", ""));
    if (parsed[0]) {
      console.log(
        `[Voice] Connected to server: ${parsed[0].virtualserver_name ?? "unknown"}`
      );
    }

    this.state = "connected";
    this.encrypted = this.encryptionKey !== null;

    // Start keep-alive pings
    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, 5000);

    this.emit("connected");
  }

  private handleTextMessage(cmd: string): void {
    const parsed = parseResponse(cmd.replace("notifytextmessage ", ""));
    if (parsed[0]) {
      this.emit("textmessage", {
        msg: parsed[0].msg ?? "",
        invokeruid: parsed[0].invokeruid ?? "",
        invokername: parsed[0].invokername ?? "",
      });
    }
  }

  private handleError(cmd: string): void {
    const parsed = parseResponse(cmd.replace("error ", ""));
    const errorId = parsed[0]?.id ?? "0";
    const errorMsg = parsed[0]?.msg ?? "ok";

    if (errorId === "0") {
      // "ok" response
      if (this.state === "connecting") {
        // clientinit accepted
      }
      return;
    }

    console.error(`[Voice] Server error ${errorId}: ${errorMsg}`);

    if (this.state === "connecting") {
      this.emit(
        "error",
        new Error(`Connection rejected: ${errorMsg} (${errorId})`)
      );
    }
  }

  private handlePingPacket(header: { packetId: number }): void {
    const pong = encodePong(header.packetId, this.clientId);
    this.send(pong);
  }

  private handleAckPacket(payload: Buffer): void {
    if (payload.length >= 2) {
      const ackedId = payload.readUInt16BE(0);
      const handler = this.pendingCommands.get(ackedId);
      if (handler) {
        // ACK received, wait for the actual response
      }
    }
  }

  // ---- Sending ----

  private send(data: Buffer): void {
    if (!this.socket) return;
    this.socket.send(data, this.options.port, this.options.host, (err) => {
      if (err) {
        console.error("[Voice] Send error:", err.message);
      }
    });
  }

  private sendAck(packetId: number): void {
    const ack = encodeAck(packetId, this.clientId);
    this.send(ack);
  }

  private sendPing(): void {
    const ping = encodePing(this.pingCounter++ & 0xffff, this.clientId);
    this.send(ping);
  }

  private sendCommandRaw(command: string): void {
    const packetId = this.commandCounter++ & 0xffff;
    const payload = Buffer.from(command, "utf-8");

    const packet = encodePacket(
      PacketType.Command,
      payload,
      packetId,
      this.clientId,
      PacketFlags.Unencrypted | PacketFlags.NewProtocol
    );

    this.send(packet);
  }

  sendCommand(
    name: string,
    params: Record<string, string | number>
  ): Promise<string> {
    const cmd = buildCommand(name, params);
    const packetId = this.commandCounter++ & 0xffff;

    return new Promise((resolve, reject) => {
      this.pendingCommands.set(packetId, { resolve, reject });

      const payload = Buffer.from(cmd, "utf-8");
      const packet = encodePacket(
        PacketType.Command,
        payload,
        packetId,
        this.clientId,
        PacketFlags.Unencrypted | PacketFlags.NewProtocol
      );
      this.send(packet);

      // Timeout
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
