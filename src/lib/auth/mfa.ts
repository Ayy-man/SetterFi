import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

/** Decode an unpadded RFC 4648 base32 TOTP secret. */
export function decodeTotpSecret(secret: string): Buffer | null {
  const normalized = secret.replace(/[\s-]/g, "").toUpperCase();
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) return null;

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length > 0 ? Buffer.from(bytes) : null;
}

function encodeTotpSecret(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return encoded;
}

/** Generate a 160-bit secret, which matches the HMAC-SHA1 output size. */
export function generateTotpSecret() {
  return encodeTotpSecret(randomBytes(20));
}

/** RFC 6238 HOTP truncation at a Unix time, with a configurable output width for published vectors. */
export function totpCode(secret: Uint8Array, unixTimeSeconds: number, digits = TOTP_DIGITS) {
  if (!Number.isSafeInteger(unixTimeSeconds) || unixTimeSeconds < 0 || !Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error("TOTP_INPUT_INVALID");
  }
  const counter = Math.floor(unixTimeSeconds / TOTP_STEP_SECONDS);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(value % (10 ** digits)).padStart(digits, "0");
}

export function mfaCode(value: unknown) {
  return typeof value === "string" && /^\d{6}$/.test(value) ? value : null;
}

function sameCode(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Returns the matched counter in the allowed minus-one/current/plus-one window, otherwise null. */
export function verifyTotpCode(secret: string, code: string, now = new Date()) {
  const decoded = decodeTotpSecret(secret);
  const parsedCode = mfaCode(code);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!decoded || !parsedCode || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) return null;
  const currentCounter = Math.floor(nowSeconds / TOTP_STEP_SECONDS);
  for (const counter of [currentCounter - 1, currentCounter, currentCounter + 1]) {
    if (counter < 0) continue;
    if (sameCode(totpCode(decoded, counter * TOTP_STEP_SECONDS), parsedCode)) return counter;
  }
  return null;
}
