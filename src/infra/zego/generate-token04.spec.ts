import { createDecipheriv } from 'node:crypto';
import { generateToken04, ZegoTokenError } from './generate-token04';

/** Decode a Token04 back to its payload to prove the format + AES round-trips. */
function decodeToken04(token: string, secret: string): Record<string, unknown> {
  expect(token.startsWith('04')).toBe(true);
  const buf = Buffer.from(token.slice(2), 'base64');
  let offset = 8; // skip expire int64
  const ivLen = buf.readUInt16BE(offset);
  offset += 2;
  const iv = buf.subarray(offset, offset + ivLen);
  offset += ivLen;
  const cipherLen = buf.readUInt16BE(offset);
  offset += 2;
  const cipher = buf.subarray(offset, offset + cipherLen);
  const algo =
    Buffer.byteLength(secret) === 16
      ? 'aes-128-cbc'
      : Buffer.byteLength(secret) === 24
        ? 'aes-192-cbc'
        : 'aes-256-cbc';
  const decipher = createDecipheriv(algo, Buffer.from(secret), iv);
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

describe('generateToken04', () => {
  const SECRET = '0123456789abcdef0123456789abcdef'; // 32 bytes → AES-256

  it('produces a "04"-prefixed token that decrypts to the expected payload', () => {
    const token = generateToken04(123456, 'user-1', SECRET, 3600, 'payload-x');
    const decoded = decodeToken04(token, SECRET);
    expect(decoded.app_id).toBe(123456);
    expect(decoded.user_id).toBe('user-1');
    expect(decoded.payload).toBe('payload-x');
    expect(typeof decoded.nonce).toBe('number');
    expect((decoded.expire as number) - (decoded.ctime as number)).toBe(3600);
  });

  it('works with a 16-byte secret (AES-128)', () => {
    const secret16 = '0123456789abcdef';
    const token = generateToken04(1, 'u', secret16, 60, '');
    expect(decodeToken04(token, secret16).user_id).toBe('u');
  });

  it('rejects an invalid appId / userId / secret / effectiveTime', () => {
    expect(() => generateToken04(0, 'u', SECRET, 60)).toThrow(ZegoTokenError);
    expect(() => generateToken04(1, '', SECRET, 60)).toThrow(ZegoTokenError);
    expect(() => generateToken04(1, 'u', '', 60)).toThrow(ZegoTokenError);
    expect(() => generateToken04(1, 'u', SECRET, 0)).toThrow(ZegoTokenError);
  });

  it('rejects a secret of invalid length at encrypt time', () => {
    expect(() => generateToken04(1, 'u', 'too-short', 60)).toThrow(ZegoTokenError);
  });
});
