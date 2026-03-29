import crypto from "crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

/** Ed25519 group order */
export const ED25519_N = BigInt(
  "7237005577332262213973186563042994240857116359379907606001950938285454250989"
);

/** TS3 root Ed25519 public key for license chain verification */
const ROOT_KEY = new Uint8Array([
  0xcd, 0x0d, 0xe2, 0xae, 0xd4, 0x63, 0x45, 0x50,
  0x9a, 0x7e, 0x3c, 0xfd, 0x8f, 0x68, 0xb3, 0xdc,
  0x75, 0x55, 0xb2, 0x9d, 0xcc, 0xec, 0x73, 0xcd,
  0x18, 0x75, 0x0f, 0x99, 0x38, 0x12, 0x40, 0x8a,
]);

interface LicenseBlock {
  data: Buffer;
}

/**
 * Parse a TS3 license chain binary blob.
 * Format: [version:1] [block0] [block1] ...
 *
 * Each block: [keyType:1][pubkey:32][blockType:1][notBefore:4][notAfter:4][typeContent:var]
 */
export function parseLicenseChain(data: Buffer): LicenseBlock[] {
  const blocks: LicenseBlock[] = [];
  let offset = 1; // skip version byte

  while (offset + 42 <= data.length) {
    const blockType = data[offset + 33];
    let blockLen = 42; // minimum header

    switch (blockType) {
      case 0x00: // Intermediate: +4 bytes + null-terminated string
        blockLen = 42 + 4;
        while (offset + blockLen < data.length && data[offset + blockLen] !== 0)
          blockLen++;
        if (offset + blockLen < data.length) blockLen++;
        break;
      case 0x01: // Website
      case 0x03: // Code
        while (offset + blockLen < data.length && data[offset + blockLen] !== 0)
          blockLen++;
        if (offset + blockLen < data.length) blockLen++;
        break;
      case 0x02: // Server: +1 license type +4 max clients + null-terminated string
        blockLen = 42 + 1 + 4;
        while (offset + blockLen < data.length && data[offset + blockLen] !== 0)
          blockLen++;
        if (offset + blockLen < data.length) blockLen++;
        break;
      case 0x08: { // TS5 Server
        if (offset + 44 > data.length) break;
        const propCount = data[offset + 43];
        let propOff = 44;
        for (let p = 0; p < propCount && offset + propOff < data.length; p++) {
          const propLen = data[offset + propOff];
          propOff += 1 + propLen;
        }
        blockLen = propOff;
        break;
      }
      case 0x20: // Ephemeral: no extra content
        blockLen = 42;
        break;
      default:
        console.warn(
          `[License] Unknown block type 0x${blockType.toString(16)}, stopping`
        );
        return blocks;
    }

    if (offset + blockLen > data.length) break;
    blocks.push({
      data: Buffer.from(data.subarray(offset, offset + blockLen)),
    });
    offset += blockLen;
  }

  return blocks;
}

/**
 * Derive the server's ephemeral Ed25519 public key from the license chain.
 *
 * Starting from ROOT_KEY, for each block:
 *   hash_key = clamp(SHA-512(block[1..])[0..32])
 *   parent = block.pubkey * hash_key + parent
 *
 * Returns compressed Ed25519 point (32 bytes).
 */
export function deriveLicenseKey(blocks: LicenseBlock[]): Uint8Array {
  const Point = ed25519.Point;
  let parent = Point.fromHex(Buffer.from(ROOT_KEY).toString("hex"));

  for (const block of blocks) {
    // SHA-512 of block data starting from byte 1 (skip key type byte)
    const hashInput = block.data.subarray(1);
    const hash = crypto.createHash("sha512").update(hashInput).digest();

    // Clamp first 32 bytes → Ed25519 scalar
    const scalarBytes = new Uint8Array(hash.subarray(0, 32));
    scalarBytes[0] &= 0xf8;
    scalarBytes[31] &= 0x3f;
    scalarBytes[31] |= 0x40;
    let scalar = bytesToBigIntLE(scalarBytes) % ED25519_N;
    if (scalar === 0n) scalar = 1n; // edge case (virtually impossible)

    // Block's Ed25519 public key (bytes 1..33)
    const blockPubKey = new Uint8Array(block.data.subarray(1, 33));
    const blockPoint = Point.fromHex(Buffer.from(blockPubKey).toString("hex"));

    // parent = blockPoint * scalar + parent
    parent = blockPoint.multiply(scalar).add(parent);
  }

  return parent.toBytes();
}

/** Convert Ed25519 public key to X25519 public key */
export function edwardsToX25519Pub(edPub: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomery(edPub);
}

/** Convert Ed25519 seed to X25519 private key */
export function edwardsToX25519Priv(edSeed: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomerySecret(edSeed);
}

export function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}
