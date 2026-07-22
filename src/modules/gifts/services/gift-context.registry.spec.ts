import { GiftContextType } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { GiftContextRegistry } from './gift-context.registry';

const handler = (contextType: GiftContextType) => ({
  contextType,
  maxReceivers: 1,
  validate: jest.fn(),
  economics: jest.fn().mockReturnValue({ receiverEarningsBps: 3000 }),
});

describe('GiftContextRegistry', () => {
  let registry: GiftContextRegistry;

  beforeEach(() => {
    registry = new GiftContextRegistry();
  });

  it('resolves a registered handler by context type', () => {
    const h = handler(GiftContextType.AUDIO_ROOM);
    registry.register(h as never);
    expect(registry.for(GiftContextType.AUDIO_ROOM)).toBe(h);
  });

  it('keeps handlers for different contexts independent', () => {
    const audio = handler(GiftContextType.AUDIO_ROOM);
    const video = handler(GiftContextType.VIDEO_ROOM);
    registry.register(audio as never);
    registry.register(video as never);
    expect(registry.for(GiftContextType.AUDIO_ROOM)).toBe(audio);
    expect(registry.for(GiftContextType.VIDEO_ROOM)).toBe(video);
  });

  it('throws GIFT_CONTEXT_INVALID for an unregistered context', () => {
    expect(() => registry.for(GiftContextType.LIVE_STREAM)).toThrow(
      expect.objectContaining({ errorCode: ERROR_CODES.GIFT_CONTEXT_INVALID }),
    );
  });

  it('rejects double registration of the same context type', () => {
    registry.register(handler(GiftContextType.VIDEO_ROOM) as never);
    expect(() => registry.register(handler(GiftContextType.VIDEO_ROOM) as never)).toThrow(
      /already registered/i,
    );
  });

  it('reports whether a context is registered', () => {
    expect(registry.has(GiftContextType.VIDEO_ROOM)).toBe(false);
    registry.register(handler(GiftContextType.VIDEO_ROOM) as never);
    expect(registry.has(GiftContextType.VIDEO_ROOM)).toBe(true);
  });
});
