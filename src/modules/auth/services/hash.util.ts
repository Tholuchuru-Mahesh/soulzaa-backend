import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex digest — used to store refresh/reset tokens and OTP codes at rest. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** A cryptographically-random opaque token (for password reset links). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** A numeric OTP code of the given length (zero-padded, uniform). */
export function randomNumericCode(length: number): string {
  const max = 10 ** length;
  return randomInt(0, max).toString().padStart(length, '0');
}
