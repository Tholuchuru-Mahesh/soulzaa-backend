import { ConfigService } from '@nestjs/config';
import { MediaUrlResolver } from './media-url.resolver';
import { S3Service } from './s3.service';

/**
 * The resolver decides, per key, whether media is served from a public bucket
 * URL or a short-lived presigned one. Getting that wrong in the permissive
 * direction publishes private conversations, so the split is pinned here rather
 * than left to the reviewer of whoever next adds a storage category.
 */
describe('MediaUrlResolver', () => {
  const PUBLIC_BASE = 'https://soulzaaa-media-prod.s3.eu-north-1.amazonaws.com';

  let s3: { getPresignedDownloadUrl: jest.Mock };

  const build = (mediaPublicBaseUrl?: string): MediaUrlResolver => {
    s3 = {
      getPresignedDownloadUrl: jest
        .fn()
        .mockImplementation(async (key: string) => `https://signed.test/${key}?X-Amz-Signature=x`),
    };
    const config = {
      get: () => ({ mediaPublicBaseUrl }),
    } as unknown as ConfigService;
    return new MediaUrlResolver(config, s3 as unknown as S3Service);
  };

  describe('with a public base configured', () => {
    it('serves a room display picture from the public base', async () => {
      const url = await build(PUBLIC_BASE).resolve('room-backgrounds/u1/dp.jpg');

      expect(url).toBe(`${PUBLIC_BASE}/room-backgrounds/u1/dp.jpg`);
      expect(s3.getPresignedDownloadUrl).not.toHaveBeenCalled();
    });

    it.each([
      ['profile-images/u1/avatar.jpg'],
      ['room-backgrounds/u1/dp.jpg'],
      ['gift-assets/rose.png'],
    ])('serves %s publicly — these are meant to be world-readable', async (key) => {
      expect(await build(PUBLIC_BASE).resolve(key)).toBe(`${PUBLIC_BASE}/${key}`);
    });

    // The whole point of the allowlist. A public URL says "anybody, forever";
    // DM media must never be described that way.
    it.each([
      ['chat-images/u1/photo.jpg'],
      ['chat-voice/u1/note.m4a'],
      ['chat-videos/u1/clip.mp4'],
      ['chat-files/u1/contract.pdf'],
    ])('still presigns %s — direct-message media is never public', async (key) => {
      const url = await build(PUBLIC_BASE).resolve(key);

      expect(url).toContain('X-Amz-Signature');
      expect(url).not.toContain(PUBLIC_BASE);
      expect(s3.getPresignedDownloadUrl).toHaveBeenCalledWith(key);
    });

    // MediaService derives thumbnail keys by swapping any category prefix for
    // `thumbnails/`, so this one bucket location holds chat thumbnails next to
    // avatar ones and cannot be made public wholesale.
    it('presigns thumbnails, which are of mixed provenance', async () => {
      const url = await build(PUBLIC_BASE).resolve('thumbnails/u1/photo.webp');

      expect(url).toContain('X-Amz-Signature');
    });

    it('does not treat a lookalike prefix as the public one', async () => {
      const url = await build(PUBLIC_BASE).resolve('profile-images-backup/u1/a.jpg');

      expect(url).toContain('X-Amz-Signature');
    });

    it('presigns an unrecognised category — new prefixes are private by default', async () => {
      const url = await build(PUBLIC_BASE).resolve('some-future-category/u1/x.bin');

      expect(url).toContain('X-Amz-Signature');
    });

    it('reports stability per key, since only public assets have stable URLs', () => {
      const resolver = build(PUBLIC_BASE);

      expect(resolver.isStable('room-backgrounds/u1/dp.jpg')).toBe(true);
      expect(resolver.isStable('chat-images/u1/photo.jpg')).toBe(false);
    });
  });

  describe('with no public base configured', () => {
    it('presigns everything, public categories included', async () => {
      const url = await build(undefined).resolve('room-backgrounds/u1/dp.jpg');

      expect(url).toContain('X-Amz-Signature');
      expect(build(undefined).isStable('room-backgrounds/u1/dp.jpg')).toBe(false);
    });
  });

  it('resolves a missing key to null rather than a URL to nothing', async () => {
    const resolver = build(PUBLIC_BASE);

    expect(await resolver.resolve(null)).toBeNull();
    expect(await resolver.resolve(undefined)).toBeNull();
    expect(await resolver.resolve('')).toBeNull();
  });

  it('tolerates a trailing slash on the configured base', async () => {
    const url = await build(`${PUBLIC_BASE}/`).resolve('room-backgrounds/u1/dp.jpg');

    expect(url).toBe(`${PUBLIC_BASE}/room-backgrounds/u1/dp.jpg`);
  });
});
