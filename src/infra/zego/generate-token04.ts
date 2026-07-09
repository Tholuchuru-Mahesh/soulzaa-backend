import { createCipheriv, randomInt } from 'node:crypto';

/**
 * ZEGOCLOUD server-side Token04 generator — a faithful TypeScript port of ZEGO's
 * official reference implementation (github.com/ZEGOCLOUD/zego_server_assistant,
 * MIT). ZEGO does not publish a working server-side npm package (the published
 * `zego-token-generator` is a browser bundle that references `window`), so the
 * official algorithm is vendored here. Uses only `node:crypto` — no dependency.
 *
 * Token format: the string `"04"` followed by base64 of
 *   [ expire:int64-BE(8) | ivLen:uint16-BE(2) | iv(16) | cipherLen:uint16-BE(2) | ciphertext ]
 * where the ciphertext is AES-CBC( JSON({app_id,user_id,nonce,ctime,expire,payload}) )
 * keyed by the app's server secret (key length selects AES-128/192/256-CBC).
 */

export class ZegoTokenError extends Error {
  constructor(
    readonly errorCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ZegoTokenError';
  }
}

const ErrorCode = {
  appIdInvalid: 1,
  userIdInvalid: 3,
  secretInvalid: 5,
  effectiveTimeInSecondsInvalid: 6,
} as const;

function aesCbcAlgorithm(secret: string): string {
  switch (Buffer.byteLength(secret)) {
    case 16:
      return 'aes-128-cbc';
    case 24:
      return 'aes-192-cbc';
    case 32:
      return 'aes-256-cbc';
    default:
      throw new ZegoTokenError(
        ErrorCode.secretInvalid,
        'ZEGO server secret must be 16, 24 or 32 bytes',
      );
  }
}

/** PKCS#7-padded AES-CBC, matching ZEGO's reference (auto padding on). */
function aesEncrypt(plainText: string, secret: string, iv: Buffer): Buffer {
  const cipher = createCipheriv(aesCbcAlgorithm(secret), Buffer.from(secret), iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
}

/** A random 16-char (16-byte) IV from the alphanumeric set, per the reference. */
function randomIv(): Buffer {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let iv = '';
  for (let i = 0; i < 16; i++) iv += alphabet[randomInt(0, alphabet.length)];
  return Buffer.from(iv);
}

/**
 * Generate a ZEGO Token04. `payload` may carry room-scoped privileges as a JSON
 * string (login/publish) so audience tokens can be prevented from publishing.
 */
export function generateToken04(
  appId: number,
  userId: string,
  secret: string,
  effectiveTimeInSeconds: number,
  payload = '',
): string {
  if (!appId || typeof appId !== 'number') {
    throw new ZegoTokenError(ErrorCode.appIdInvalid, 'appId is invalid');
  }
  if (!userId || typeof userId !== 'string' || userId.length > 64) {
    throw new ZegoTokenError(ErrorCode.userIdInvalid, 'userId is invalid');
  }
  if (!secret || typeof secret !== 'string' || Buffer.byteLength(secret) === 0) {
    throw new ZegoTokenError(ErrorCode.secretInvalid, 'secret is invalid');
  }
  if (!effectiveTimeInSeconds || effectiveTimeInSeconds <= 0) {
    throw new ZegoTokenError(
      ErrorCode.effectiveTimeInSecondsInvalid,
      'effectiveTimeInSeconds is invalid',
    );
  }

  const createTime = Math.floor(Date.now() / 1000);
  const tokenInfo = {
    app_id: appId,
    user_id: userId,
    // 32-bit signed nonce, per the reference.
    nonce: randomInt(-2147483648, 2147483648),
    ctime: createTime,
    expire: createTime + effectiveTimeInSeconds,
    payload: payload || '',
  };

  const plainText = JSON.stringify(tokenInfo);
  const iv = randomIv();
  const cipher = aesEncrypt(plainText, secret, iv);

  const expireBytes = Buffer.alloc(8);
  expireBytes.writeBigInt64BE(BigInt(tokenInfo.expire));
  const ivLen = Buffer.alloc(2);
  ivLen.writeUInt16BE(iv.length);
  const cipherLen = Buffer.alloc(2);
  cipherLen.writeUInt16BE(cipher.length);

  const packed = Buffer.concat([expireBytes, ivLen, iv, cipherLen, cipher]);
  return '04' + packed.toString('base64');
}
