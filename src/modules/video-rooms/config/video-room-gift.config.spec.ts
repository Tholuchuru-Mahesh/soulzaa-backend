import { loadVideoRoomGiftConfig, toBool } from './video-room-gift.config';

const raw = (overrides: Record<string, unknown> = {}) => ({
  maxReceivers: '9',
  allowRoomAll: 'false',
  allowViewerGiftsDefault: 'true',
  recentFeedSize: '50',
  monitorIntervalSeconds: '15',
  recoveryEnabled: 'false',
  blockedCountries: '',
  ...overrides,
});

const configWith = (value: unknown) => ({ get: jest.fn().mockReturnValue(value) }) as never;

describe('toBool', () => {
  /**
   * The repo-wide `z.coerce.boolean()` idiom turns the STRING "false" into true.
   * These cases are the reason this helper exists.
   */
  it.each(['false', 'FALSE', '0', 'no', 'off', ' false '])('treats %p as false', (value) => {
    expect(toBool(value, true)).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on'])('treats %p as true', (value) => {
    expect(toBool(value, false)).toBe(true);
  });

  it('passes through real booleans', () => {
    expect(toBool(true, false)).toBe(true);
    expect(toBool(false, true)).toBe(false);
  });

  it('falls back when undefined or empty', () => {
    expect(toBool(undefined, true)).toBe(true);
    expect(toBool('', false)).toBe(false);
    expect(toBool('   ', true)).toBe(true);
  });
});

describe('loadVideoRoomGiftConfig', () => {
  it('coerces the namespace into typed values', () => {
    expect(loadVideoRoomGiftConfig(configWith(raw()))).toEqual({
      maxReceivers: 9,
      allowRoomAll: false,
      allowViewerGiftsDefault: true,
      recentFeedSize: 50,
      monitorIntervalSeconds: 15,
      recoveryEnabled: false,
      blockedCountries: [],
    });
  });

  it('parses blocked countries into upper-cased codes', () => {
    const cfg = loadVideoRoomGiftConfig(configWith(raw({ blockedCountries: ' us , in ,' })));
    expect(cfg.blockedCountries).toEqual(['US', 'IN']);
  });

  it('drops empty entries so a trailing comma matches nothing', () => {
    const cfg = loadVideoRoomGiftConfig(configWith(raw({ blockedCountries: ',,' })));
    expect(cfg.blockedCountries).toEqual([]);
  });

  it('keeps ROOM_ALL disabled when the env literally says "false"', () => {
    const cfg = loadVideoRoomGiftConfig(configWith(raw({ allowRoomAll: 'false' })));
    expect(cfg.allowRoomAll).toBe(false);
  });

  it('enables ROOM_ALL only on an affirmative value', () => {
    const cfg = loadVideoRoomGiftConfig(configWith(raw({ allowRoomAll: 'true' })));
    expect(cfg.allowRoomAll).toBe(true);
  });

  it('throws when the namespace is not registered', () => {
    expect(() => loadVideoRoomGiftConfig(configWith(undefined))).toThrow(
      /videoRoomGift config namespace/,
    );
  });
});
