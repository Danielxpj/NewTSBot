import { Packet, PacketHeader, PacketType, PacketFlags } from "./protocol";

/** Client → Server header: MAC(8) + PacketId(2) + ClientId(2) + TypeFlags(1) = 13 */
const C2S_HEADER_SIZE = 13;

/** Server → Client header: MAC(8) + PacketId(2) + TypeFlags(1) = 11 */
const S2C_HEADER_SIZE = 11;

/** TS3 magic MAC for init packets */
const TS3INIT1_MAC = Buffer.from("TS3INIT1", "ascii");

/** Encode a packet to send (Client → Server, 13-byte header) */
export function encodePacket(
  type: PacketType,
  payload: Buffer,
  packetId: number,
  clientId: number = 0,
  flags: number = PacketFlags.None
): Buffer {
  const buf = Buffer.alloc(C2S_HEADER_SIZE + payload.length);

  // MAC - 8 bytes
  if (type === PacketType.Init) {
    TS3INIT1_MAC.copy(buf, 0);
  } else {
    buf.fill(0, 0, 8);
  }

  // Packet ID - 2 bytes big endian
  buf.writeUInt16BE(packetId, 8);

  // Client ID - 2 bytes big endian (C→S only)
  buf.writeUInt16BE(clientId, 10);

  // Flags (upper 4 bits) + Type (lower 4 bits)
  buf[12] = (flags & 0xf0) | (type & 0x0f);

  // Payload
  payload.copy(buf, C2S_HEADER_SIZE);

  return buf;
}

/** Decode a received packet (Server → Client, 11-byte header) */
export function decodePacket(data: Buffer): Packet {
  if (data.length < S2C_HEADER_SIZE) {
    throw new Error(`Packet too short: ${data.length} bytes`);
  }

  const header: PacketHeader = {
    mac: data.subarray(0, 8),
    packetId: data.readUInt16BE(8),
    clientId: 0, // S→C packets don't have ClientId
    flags: data[10] & 0xf0,
    type: data[10] & 0x0f,
  };

  const payload = data.subarray(S2C_HEADER_SIZE);

  return { header, payload, raw: data };
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
