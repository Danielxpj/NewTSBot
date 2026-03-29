import { Packet, PacketHeader, PacketType, PacketFlags } from "./protocol";

const HEADER_SIZE = 13; // MAC(8) + PacketId(2) + ClientId(2) + TypeFlags(1)

/** Encode a packet to a buffer for sending */
export function encodePacket(
  type: PacketType,
  payload: Buffer,
  packetId: number,
  clientId: number = 0,
  flags: number = PacketFlags.None
): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE + payload.length);

  // MAC - 8 bytes (zeros before encryption)
  buf.fill(0, 0, 8);

  // Packet ID - 2 bytes big endian
  buf.writeUInt16BE(packetId, 8);

  // Client ID - 2 bytes big endian
  buf.writeUInt16BE(clientId, 10);

  // Flags (upper 4 bits) + Type (lower 4 bits)
  buf[12] = (flags & 0xf0) | (type & 0x0f);

  // Payload
  payload.copy(buf, HEADER_SIZE);

  return buf;
}

/** Decode a received buffer into a packet */
export function decodePacket(data: Buffer): Packet {
  if (data.length < HEADER_SIZE) {
    throw new Error(`Packet too short: ${data.length} bytes`);
  }

  const header: PacketHeader = {
    mac: data.subarray(0, 8),
    packetId: data.readUInt16BE(8),
    clientId: data.readUInt16BE(10),
    flags: data[12] & 0xf0,
    type: data[12] & 0x0f,
  };

  const payload = data.subarray(HEADER_SIZE);

  return { header, payload, raw: data };
}

/** Create an Init1 packet for the handshake */
export function createInit1(step: number, data: Buffer): Buffer {
  // Init packets use Unencrypted flag
  const payload = Buffer.alloc(1 + data.length);
  payload[0] = step;
  data.copy(payload, 1);
  return encodePacket(
    PacketType.Init,
    payload,
    101, // Standard init packet ID
    0,
    PacketFlags.Unencrypted
  );
}

/** Extract header bytes used for encryption (meta data for EAX) */
export function getHeaderBytes(packet: Buffer): Buffer {
  // For EAX: the "header" is bytes 8..12 (packetId + clientId + type/flags)
  return packet.subarray(8, 13);
}

/** Encode a command packet (type=Command, unencrypted) */
export function encodeCommandPacket(
  command: string,
  packetId: number,
  clientId: number = 0,
  encrypted: boolean = false
): Buffer {
  const payload = Buffer.from(command, "utf-8");
  const flags = encrypted ? PacketFlags.NewProtocol : PacketFlags.Unencrypted | PacketFlags.NewProtocol;
  return encodePacket(PacketType.Command, payload, packetId, clientId, flags);
}

/** Encode a voice packet */
export function encodeVoicePacket(
  packetId: number,
  clientId: number,
  codec: number,
  voiceData: Buffer,
  encrypted: boolean = false
): Buffer {
  // Voice payload: [PacketCounter:2][codec:1][data...]
  const payload = Buffer.alloc(3 + voiceData.length);
  payload.writeUInt16BE(packetId, 0); // voice packet counter
  payload[2] = codec;
  voiceData.copy(payload, 3);

  const flags = encrypted ? PacketFlags.None : PacketFlags.Unencrypted;
  return encodePacket(PacketType.Voice, payload, packetId, clientId, flags);
}

/** Encode a ping packet */
export function encodePing(packetId: number, clientId: number): Buffer {
  return encodePacket(
    PacketType.Ping,
    Buffer.alloc(0),
    packetId,
    clientId,
    PacketFlags.Unencrypted
  );
}

/** Encode a pong packet */
export function encodePong(
  pingPacketId: number,
  clientId: number
): Buffer {
  return encodePacket(
    PacketType.Pong,
    Buffer.alloc(0),
    pingPacketId,
    clientId,
    PacketFlags.Unencrypted
  );
}

/** Encode an ACK packet */
export function encodeAck(
  ackPacketId: number,
  clientId: number
): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(ackPacketId, 0);
  return encodePacket(
    PacketType.Ack,
    payload,
    ackPacketId,
    clientId,
    PacketFlags.Unencrypted
  );
}
