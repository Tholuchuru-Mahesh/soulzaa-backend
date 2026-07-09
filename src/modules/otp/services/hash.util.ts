import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex digest — OTP codes are stored only as hashes, never plaintext. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of two hex digests of equal length (replay/timing safe). */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** A numeric OTP code of the given length (zero-padded, uniform distribution). */
export function randomNumericCode(length: number): string {
  const max = 10 ** length;
  return randomInt(0, max).toString().padStart(length, '0');
}
