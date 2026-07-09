import { createHash } from 'node:crypto';

/** SHA-256 hex digest — refresh tokens are stored only as hashes at rest. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
