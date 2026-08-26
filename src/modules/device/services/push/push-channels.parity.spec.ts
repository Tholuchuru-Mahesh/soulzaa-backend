import { ALL_PUSH_CHANNEL_IDS, PUSH_CATEGORIES } from '../../interfaces/push.constants';

/**
 * The Flutter client hand-registers every channel the server can name
 * (`push_channels.dart`). Android silently DROPS a push naming a channel the app
 * never created, so drift between these two lists is invisible in production —
 * no error, no log, just notifications that never appear.
 *
 * This literal is the contract, mirrored verbatim in the client's
 * `test/core/push_channels_parity_test.dart`. Changing one side without the other
 * fails here or there, which is the only reason the drift is ever caught.
 */
const EXPECTED_CHANNEL_IDS: readonly string[] = [
  'soulzaa_calls',
  'soulzaa_default',
  ...[
    'soulzaa_messages',
    'soulzaa_social',
    'soulzaa_wallet',
    'soulzaa_games',
    'soulzaa_vip',
    'soulzaa_family',
    'soulzaa_wealth',
  ].flatMap((prefix) => ['sv', 'sn', 'nv', 'nn'].map((tone) => `${prefix}_${tone}`)),
];

describe('push channel contract', () => {
  it('server channel ids exactly match the set the Flutter client registers', () => {
    expect([...ALL_PUSH_CHANNEL_IDS].sort()).toEqual([...EXPECTED_CHANNEL_IDS].sort());
  });

  it('exposes the four new domain categories', () => {
    expect(PUSH_CATEGORIES.WALLET).toBe('WALLET');
    expect(PUSH_CATEGORIES.GAME).toBe('GAME');
    expect(PUSH_CATEGORIES.VIP).toBe('VIP');
    expect(PUSH_CATEGORIES.FAMILY).toBe('FAMILY');
  });
});
