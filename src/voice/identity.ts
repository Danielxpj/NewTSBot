import crypto from "crypto";

export interface TS3Identity {
  privateKey: Buffer;
  publicKey: Buffer;   // 65-byte uncompressed EC point
  omega: Buffer;       // Custom ASN.1 DER for TS3 (used in clientinitiv)
  omegaBase64: string; // Base64 of omega
  keyOffset: number;
  securityLevel: number;
}

/**
 * Generate a new TS3 identity with the specified minimum security level.
 *
 * TS3 identities are P-256 EC key pairs. The security level is
 * the number of leading zero bits in SHA1(base64(omega) + decimal(offset)).
 */
export function generateIdentity(minLevel: number = 8): TS3Identity {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();

  const privateKey = ecdh.getPrivateKey();
  const publicKey = ecdh.getPublicKey(); // 65 bytes uncompressed
  const omega = encodeOmega(publicKey);
  const omegaBase64 = omega.toString("base64");

  // Find key offset for required security level
  let keyOffset = 0;
  let securityLevel = 0;

  while (securityLevel < minLevel) {
    const hash = hashIdentity(omegaBase64, keyOffset);
    securityLevel = countLeadingZeroBits(hash);
    if (securityLevel < minLevel) keyOffset++;
  }

  return { privateKey, publicKey, omega, omegaBase64, keyOffset, securityLevel };
}

/** Create an ECDH from an existing identity */
export function identityToECDH(identity: TS3Identity): crypto.ECDH {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(identity.privateKey);
  return ecdh;
}

/**
 * Encode an EC public key in the TS3 custom ASN.1 DER format (libtomcrypt compatible):
 *
 *   SEQUENCE {
 *     BIT STRING (0x00, 7 unused bits)   -- flags: public-only
 *     INTEGER 32                          -- key size
 *     INTEGER <X coordinate>
 *     INTEGER <Y coordinate>
 *   }
 */
export function encodeOmega(publicKey: Buffer): Buffer {
  const x = publicKey.subarray(1, 33);
  const y = publicKey.subarray(33, 65);

  const bitStr = Buffer.from([0x03, 0x02, 0x07, 0x00]); // BIT STRING: 1 bit = 0 (public-only flag)
  const keySize = Buffer.from([0x02, 0x01, 0x20]);       // INTEGER 32
  const xInt = derInteger(x);
  const yInt = derInteger(y);

  const content = Buffer.concat([bitStr, keySize, xInt, yInt]);
  // SEQUENCE tag + length + content
  return Buffer.concat([Buffer.from([0x30, content.length]), content]);
}

/**
 * Decode the TS3 custom ASN.1 DER omega format back to raw EC point (65 bytes).
 * Returns Buffer starting with 0x04.
 */
export function decodeOmega(omega: Buffer): Buffer {
  // Skip: SEQUENCE tag+len, BIT STRING (4 bytes), INTEGER 32 (3 bytes)
  // Then two INTEGERs for X and Y
  let offset = 2; // skip SEQUENCE tag + length

  // Skip BIT STRING (03 02 07 00)
  offset += 2 + omega[offset + 1];

  // Skip INTEGER 32 (02 01 20)
  offset += 2 + omega[offset + 1];

  // Read X INTEGER
  const xLen = omega[offset + 1];
  const xData = omega.subarray(offset + 2, offset + 2 + xLen);
  offset += 2 + xLen;

  // Read Y INTEGER
  const yLen = omega[offset + 1];
  const yData = omega.subarray(offset + 2, offset + 2 + yLen);

  // Pad/trim to 32 bytes each
  const x = padOrTrim(xData, 32);
  const y = padOrTrim(yData, 32);

  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

/** DER-encode a big unsigned integer */
function derInteger(value: Buffer): Buffer {
  // Trim leading zeros
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  let trimmed = value.subarray(start);

  // If high bit set, prepend 0x00 (positive sign)
  const needsPad = (trimmed[0] & 0x80) !== 0;
  const len = trimmed.length + (needsPad ? 1 : 0);

  const buf = Buffer.alloc(2 + len);
  buf[0] = 0x02; // INTEGER tag
  buf[1] = len;
  if (needsPad) {
    buf[2] = 0x00;
    trimmed.copy(buf, 3);
  } else {
    trimmed.copy(buf, 2);
  }
  return buf;
}

/** Pad to length (prepend zeros) or trim leading zeros to length */
function padOrTrim(buf: Buffer, length: number): Buffer {
  if (buf.length === length) return Buffer.from(buf);
  if (buf.length > length) {
    // Trim leading zeros/padding
    return Buffer.from(buf.subarray(buf.length - length));
  }
  // Pad with leading zeros
  const result = Buffer.alloc(length);
  buf.copy(result, length - buf.length);
  return result;
}

/**
 * Hash for security level: SHA1(base64(omega) + decimal(offset))
 */
function hashIdentity(omegaBase64: string, offset: number): Buffer {
  return crypto
    .createHash("sha1")
    .update(omegaBase64 + offset.toString(10))
    .digest();
}

function countLeadingZeroBits(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      count += 8;
    } else {
      for (let bit = 7; bit >= 0; bit--) {
        if ((buf[i] >> bit) & 1) return count;
        count++;
      }
    }
  }
  return count;
}
