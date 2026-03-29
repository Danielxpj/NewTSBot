import crypto from "crypto";

/**
 * TS3 Identity
 *
 * A TS3 identity is an ECC key pair (prime256v1/secp256r1).
 * The security level is determined by proof-of-work:
 * count leading zero bits of SHA1(publicKeyASN1 + counter).
 */

export interface TS3Identity {
  privateKey: Buffer;
  publicKey: Buffer;
  keyOffset: number;
  securityLevel: number;
  exportString: string;
}

/** Generate a new TS3 identity with the specified minimum security level */
export function generateIdentity(minLevel: number = 8): TS3Identity {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();

  const privateKey = ecdh.getPrivateKey();
  const publicKey = ecdh.getPublicKey();

  // Find a key offset that gives us the required security level
  let keyOffset = 0;
  let securityLevel = 0;

  while (securityLevel < minLevel) {
    const hash = hashIdentity(publicKey, keyOffset);
    securityLevel = countLeadingZeroBits(hash);
    if (securityLevel < minLevel) {
      keyOffset++;
    }
  }

  // Export format: base64(keyOffset + publicKey + privateKey)
  const exportBuf = Buffer.alloc(8 + publicKey.length + privateKey.length);
  exportBuf.writeBigUInt64BE(BigInt(keyOffset), 0);
  publicKey.copy(exportBuf, 8);
  privateKey.copy(exportBuf, 8 + publicKey.length);
  const exportString = exportBuf.toString("base64");

  return { privateKey, publicKey, keyOffset, securityLevel, exportString };
}

/** Hash an identity public key with the given offset */
function hashIdentity(publicKey: Buffer, offset: number): Buffer {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(offset), 0);
  return crypto
    .createHash("sha1")
    .update(publicKey)
    .update(counterBuf)
    .digest();
}

/** Count leading zero bits in a buffer */
function countLeadingZeroBits(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      count += 8;
    } else {
      // Count leading zeros in this byte
      let b = buf[i];
      for (let bit = 7; bit >= 0; bit--) {
        if ((b >> bit) & 1) return count;
        count++;
      }
    }
  }
  return count;
}

/** Get the identity public key in the format TS3 expects for clientinit */
export function getIdentityPublicKeyBase64(identity: TS3Identity): string {
  return identity.publicKey.toString("base64");
}

/** Create an ECDH object from an existing identity (for the handshake) */
export function identityToECDH(identity: TS3Identity): crypto.ECDH {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(identity.privateKey);
  return ecdh;
}
