import { isPublicAssetKey } from './storage.constants';

/**
 * `isPublicAssetKey` is the only thing standing between an unauthenticated GET
 * and the private namespaces, so the negative cases matter more than the
 * positive ones.
 */
describe('isPublicAssetKey', () => {
  it('allows catalog assets rendered by <img>', () => {
    expect(isPublicAssetKey('cosmetic-assets/frame_01.png')).toBe(true);
    expect(isPublicAssetKey('gift-assets/rose.webp')).toBe(true);
    expect(isPublicAssetKey('profile-images/u1/avatar.jpg')).toBe(true);
    expect(isPublicAssetKey('thumbnails/x/y/z.png')).toBe(true);
  });

  it('refuses identity documents and moderation evidence', () => {
    expect(isPublicAssetKey('kyc-documents/u1/aadhaar.pdf')).toBe(false);
    expect(isPublicAssetKey('broad-ban-evidence/case-1.png')).toBe(false);
  });

  it('refuses direct-message media', () => {
    expect(isPublicAssetKey('chat-images/room-1/a.jpg')).toBe(false);
    expect(isPublicAssetKey('chat-voice/room-1/a.m4a')).toBe(false);
    expect(isPublicAssetKey('chat-files/room-1/a.pdf')).toBe(false);
  });

  it('matches whole segments, so a lookalike prefix cannot pass', () => {
    expect(isPublicAssetKey('gift-assets-private/secret.png')).toBe(false);
    expect(isPublicAssetKey('cosmetic-assetsX/secret.png')).toBe(false);
    // The dangerous direction: a private namespace dressed as a public one.
    expect(isPublicAssetKey('kyc-documents-cosmetic-assets/id.pdf')).toBe(false);
  });

  it('refuses traversal out of a public namespace', () => {
    expect(isPublicAssetKey('cosmetic-assets/../kyc-documents/id.pdf')).toBe(false);
  });

  it('refuses empty and leading-slash-only keys', () => {
    expect(isPublicAssetKey('')).toBe(false);
    expect(isPublicAssetKey('/')).toBe(false);
  });

  it('tolerates a leading slash on an otherwise public key', () => {
    expect(isPublicAssetKey('/cosmetic-assets/frame_01.png')).toBe(true);
  });
});
