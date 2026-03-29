import crypto from "crypto";

/**
 * AES-128 CMAC (OMAC1) implementation
 * Used as a building block for EAX mode
 */
function aesCmac(key: Buffer, message: Buffer): Buffer {
  const BLOCK_SIZE = 16;

  // Generate subkeys
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const L = cipher.update(Buffer.alloc(BLOCK_SIZE));
  cipher.final();

  const K1 = doubleBlock(L);
  const K2 = doubleBlock(K1);

  const n = Math.ceil(message.length / BLOCK_SIZE) || 1;
  const lastBlockComplete =
    message.length > 0 && message.length % BLOCK_SIZE === 0;

  // Prepare last block
  const lastBlock = Buffer.alloc(BLOCK_SIZE);
  const lastStart = (n - 1) * BLOCK_SIZE;
  const lastLen = message.length - lastStart;

  if (lastBlockComplete) {
    message.copy(lastBlock, 0, lastStart, lastStart + BLOCK_SIZE);
    xorInPlace(lastBlock, K1);
  } else {
    if (lastLen > 0) {
      message.copy(lastBlock, 0, lastStart, lastStart + lastLen);
    }
    lastBlock[lastLen] = 0x80; // Padding
    xorInPlace(lastBlock, K2);
  }

  // CBC-MAC
  let x = Buffer.alloc(BLOCK_SIZE);
  const cbcCipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cbcCipher.setAutoPadding(false);

  for (let i = 0; i < n - 1; i++) {
    const block = message.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE);
    xorInPlace(x, block);
    x = cbcCipher.update(x);
  }

  xorInPlace(x, lastBlock);
  const finalCipher = crypto.createCipheriv("aes-128-ecb", key, null);
  finalCipher.setAutoPadding(false);
  x = finalCipher.update(x);
  finalCipher.final();

  return x;
}

/** Double a block in GF(2^128) */
function doubleBlock(block: Buffer): Buffer {
  const result = Buffer.alloc(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    const tmp = (block[i] << 1) | carry;
    result[i] = tmp & 0xff;
    carry = (tmp >> 8) & 1;
  }
  if (block[0] & 0x80) {
    result[15] ^= 0x87; // Reduction polynomial for GF(2^128)
  }
  return result;
}

/** XOR src into dst in place */
function xorInPlace(dst: Buffer, src: Buffer): void {
  for (let i = 0; i < dst.length && i < src.length; i++) {
    dst[i] ^= src[i];
  }
}

/** XOR two buffers and return new buffer */
function xorBuffers(a: Buffer, b: Buffer): Buffer {
  const result = Buffer.alloc(Math.max(a.length, b.length));
  for (let i = 0; i < result.length; i++) {
    result[i] = (a[i] || 0) ^ (b[i] || 0);
  }
  return result;
}

/**
 * AES-128-EAX encryption
 * Provides authenticated encryption used by TS3
 */
export function eaxEncrypt(
  key: Buffer,
  nonce: Buffer,
  header: Buffer,
  plaintext: Buffer
): { ciphertext: Buffer; mac: Buffer } {
  const BLOCK_SIZE = 16;

  // N* = OMAC(0 || nonce)
  const nonceTag = Buffer.alloc(BLOCK_SIZE);
  const noncePadded = Buffer.concat([nonceTag, nonce]); // tag 0x00... || nonce
  const nStar = aesCmac(key, noncePadded);

  // H* = OMAC(1 || header)
  const headerTag = Buffer.alloc(BLOCK_SIZE);
  headerTag[15] = 1;
  const headerPadded = Buffer.concat([headerTag, header]);
  const hStar = aesCmac(key, headerPadded);

  // CTR encrypt
  const ctrCipher = crypto.createCipheriv("aes-128-ctr", key, nStar);
  const ciphertext = ctrCipher.update(plaintext);
  ctrCipher.final();

  // T* = OMAC(2 || ciphertext)
  const cipherTag = Buffer.alloc(BLOCK_SIZE);
  cipherTag[15] = 2;
  const cipherPadded = Buffer.concat([cipherTag, ciphertext]);
  const tStar = aesCmac(key, cipherPadded);

  // MAC = N* XOR H* XOR T*
  const mac = xorBuffers(xorBuffers(nStar, hStar), tStar);

  return { ciphertext, mac };
}

/**
 * AES-128-EAX decryption
 */
export function eaxDecrypt(
  key: Buffer,
  nonce: Buffer,
  header: Buffer,
  ciphertext: Buffer,
  mac: Buffer
): Buffer | null {
  const BLOCK_SIZE = 16;

  // N* = OMAC(0 || nonce)
  const nonceTag = Buffer.alloc(BLOCK_SIZE);
  const noncePadded = Buffer.concat([nonceTag, nonce]);
  const nStar = aesCmac(key, noncePadded);

  // H* = OMAC(1 || header)
  const headerTag = Buffer.alloc(BLOCK_SIZE);
  headerTag[15] = 1;
  const headerPadded = Buffer.concat([headerTag, header]);
  const hStar = aesCmac(key, headerPadded);

  // T* = OMAC(2 || ciphertext)
  const cipherTag = Buffer.alloc(BLOCK_SIZE);
  cipherTag[15] = 2;
  const cipherPadded = Buffer.concat([cipherTag, ciphertext]);
  const tStar = aesCmac(key, cipherPadded);

  // Verify MAC
  const expectedMac = xorBuffers(xorBuffers(nStar, hStar), tStar);
  if (!crypto.timingSafeEqual(mac.subarray(0, 8), expectedMac.subarray(0, 8))) {
    return null; // MAC verification failed
  }

  // CTR decrypt
  const ctrDecipher = crypto.createDecipheriv("aes-128-ctr", key, nStar);
  const plaintext = ctrDecipher.update(ciphertext);
  ctrDecipher.final();

  return plaintext;
}

/**
 * Derive encryption keys from the shared secret (after ECDH)
 *
 * TS3 uses: SHA-512(sharedSecret) -> first 16 bytes = key, next 16 = nonce/IV
 */
export function deriveKeys(sharedSecret: Buffer): {
  key: Buffer;
  nonce: Buffer;
} {
  const hash = crypto.createHash("sha512").update(sharedSecret).digest();
  return {
    key: hash.subarray(0, 16),
    nonce: hash.subarray(16, 32),
  };
}

/**
 * Generate a temporary ECDH key pair for the handshake
 */
export function generateECDH(): crypto.ECDH {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh;
}

/**
 * Compute shared secret from our ECDH and the server's public key
 */
export function computeSharedSecret(
  ecdh: crypto.ECDH,
  serverPublicKey: Buffer
): Buffer {
  return ecdh.computeSecret(serverPublicKey);
}

/**
 * TS3 uses a specific nonce generation for each packet.
 * The nonce is: baseNonce XOR generationId (as 16-byte big-endian)
 */
export function generatePacketNonce(
  baseNonce: Buffer,
  generationId: number,
  packetId: number,
  isServerToClient: boolean
): Buffer {
  const nonce = Buffer.from(baseNonce);
  // XOR with direction + generation + packetId
  const temp = Buffer.alloc(16);
  // Last 4 bytes: generation counter
  temp.writeUInt32BE(generationId, 12);
  // Byte at offset 8: direction (1 = server->client, 0 = client->server)
  if (isServerToClient) {
    temp[8] = 1;
  }
  // Bytes 10-11: packet ID
  temp.writeUInt16BE(packetId, 10);

  for (let i = 0; i < 16; i++) {
    nonce[i] ^= temp[i];
  }
  return nonce;
}
