import { loadVideoRoomChatConfig } from './video-room-chat.config';

describe('loadVideoRoomChatConfig', () => {
  // Namespaced config values surface as raw process.env STRINGS at runtime.
  // Coercing once behind this accessor is what stops '20' > 5 comparisons
  // from silently doing string comparison across every call site.
  it('coerces string env values to numbers', () => {
    const config = {
      get: () => ({
        messageMaxLength: '500',
        maxMentions: '10',
        maxPins: '3',
        rateMax: '20',
        rateWindowSeconds: '60',
        dedupWindowSeconds: '30',
        floodBurstMax: '5',
        floodBurstWindowSeconds: '2',
        cooldownSteps: '10,30,120',
        recentBufferSize: '100',
        recentBufferTtlSeconds: '3600',
        typingTtlSeconds: '5',
        recallWindowSeconds: '120',
        editWindowSeconds: '900',
        receiptThrottleMs: '2000',
        systemMessageBroadcastOnlyAboveViewers: '200',
        systemMessageSuppressAboveViewers: '2000',
      }),
    };

    const cfg = loadVideoRoomChatConfig(config as never);

    expect(cfg.messageMaxLength).toBe(500);
    expect(cfg.rateMax).toBe(20);
    expect(cfg.editWindowSeconds).toBe(900);
    expect(cfg.cooldownSteps).toEqual([10, 30, 120]);
  });

  it('throws when the namespace is not registered', () => {
    const config = { get: () => undefined };
    expect(() => loadVideoRoomChatConfig(config as never)).toThrow(
      'videoRoomChat config namespace is not registered',
    );
  });
});
