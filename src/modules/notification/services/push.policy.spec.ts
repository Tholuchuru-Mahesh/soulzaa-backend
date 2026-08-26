import {
  PUSH_CATEGORIES,
  PUSH_CHANNELS,
  pushChannelId,
} from 'src/modules/device/interfaces/push.constants';
import type { NotificationPreferenceView, PushIntent } from '../interfaces/notification.interface';
import { PushPolicy } from './push.policy';

const allOn: NotificationPreferenceView = {
  pushEnabled: true,
  messageEvents: true,
  callEvents: true,
  friendEvents: true,
  followEvents: true,
  inviteEvents: true,
  giftEvents: true,
  systemEvents: true,
  roomEvents: true,
  seatEvents: true,
  treasureEvents: true,
  pkEvents: true,
  announcementEvents: true,
  walletEvents: true,
  gameEvents: true,
  vipEvents: true,
  wealthEvents: true,
  familyEvents: true,
  sound: true,
  vibration: true,
  showPreview: true,
  mutedUntil: null,
};

const prefs = (patch: Partial<NotificationPreferenceView> = {}): NotificationPreferenceView => ({
  ...allOn,
  ...patch,
});

const message: PushIntent = {
  category: PUSH_CATEGORIES.MESSAGE,
  title: 'Ada',
  body: 'the actual private message text',
  redactedBody: 'New message',
  threadId: 'chat_c1',
  badge: 'unread',
};

describe('PushPolicy', () => {
  const policy = new PushPolicy();

  describe('suppression', () => {
    it('delivers when everything is enabled', () => {
      expect(policy.resolve(message, prefs(), 3)).not.toBeNull();
    });

    it('suppresses every category when the master switch is off', () => {
      const off = prefs({ pushEnabled: false });
      for (const category of Object.values(PUSH_CATEGORIES)) {
        if (category === PUSH_CATEGORIES.SECURITY) continue;
        expect(policy.allows(category, off)).toBe(false);
      }
    });

    it('never suppresses a security alert — not by the master switch, a snooze, or anything else', () => {
      const locked = prefs({
        pushEnabled: false,
        systemEvents: false,
        mutedUntil: new Date(Date.now() + 60_000),
      });
      expect(policy.allows(PUSH_CATEGORIES.SECURITY, locked)).toBe(true);
    });

    it('suppresses while snoozed, and delivers once the snooze has elapsed', () => {
      const snoozed = prefs({ mutedUntil: new Date(Date.now() + 60_000) });
      const expired = prefs({ mutedUntil: new Date(Date.now() - 1) });

      expect(policy.allows(PUSH_CATEGORIES.MESSAGE, snoozed)).toBe(false);
      expect(policy.allows(PUSH_CATEGORIES.MESSAGE, expired)).toBe(true);
    });

    it('gates each category on its own switch, leaving the others alone', () => {
      const noCalls = prefs({ callEvents: false });
      expect(policy.allows(PUSH_CATEGORIES.CALL, noCalls)).toBe(false);
      expect(policy.allows(PUSH_CATEGORIES.MESSAGE, noCalls)).toBe(true);
    });
  });

  describe('redaction', () => {
    it('sends the real body when previews are on', () => {
      expect(policy.resolve(message, prefs(), 0)?.body).toBe('the actual private message text');
    });

    it('replaces the body before it leaves the server when previews are off', () => {
      const resolved = policy.resolve(message, prefs({ showPreview: false }), 0);
      expect(resolved?.body).toBe('New message');
      // The whole point: the private text is not in the payload at all.
      expect(JSON.stringify(resolved)).not.toContain('the actual private message text');
    });

    it('falls back to the body when the producer offered nothing to redact to', () => {
      const nothingPrivate: PushIntent = { ...message, redactedBody: undefined };
      expect(policy.resolve(nothingPrivate, prefs({ showPreview: false }), 0)?.body).toBe(
        'the actual private message text',
      );
    });
  });

  describe('channel selection', () => {
    it('puts a sound-on user on the audible channel and a sound-off user on a different one', () => {
      const loud = policy.resolve(message, prefs(), 0)!.channelId;
      const quiet = policy.resolve(message, prefs({ sound: false }), 0)!.channelId;

      expect(loud).not.toBe(quiet);
      expect(loud).toBe(pushChannelId(PUSH_CATEGORIES.MESSAGE, { sound: true, vibration: true }));
    });

    it('distinguishes all four sound/vibration combinations', () => {
      const ids = new Set(
        [true, false].flatMap((sound) =>
          [true, false].map(
            (vibration) => policy.resolve(message, prefs({ sound, vibration }), 0)!.channelId,
          ),
        ),
      );
      expect(ids.size).toBe(4);
    });

    it('always rings a call, whatever the user asked for — a silent ringtone is a missed call', () => {
      const silent = prefs({ sound: false, vibration: false });
      const call: PushIntent = { ...message, category: PUSH_CATEGORIES.CALL };
      expect(policy.resolve(call, silent, 0)!.channelId).toBe(PUSH_CHANNELS.CALLS);
    });

    it('puts a security alert on the default channel', () => {
      const alert: PushIntent = { ...message, category: PUSH_CATEGORIES.SECURITY };
      expect(policy.resolve(alert, prefs({ pushEnabled: false }), 0)!.channelId).toBe(
        PUSH_CHANNELS.DEFAULT,
      );
    });
  });

  describe('badge', () => {
    it("resolves 'unread' to the count it was handed", () => {
      expect(policy.resolve(message, prefs(), 7)?.badge).toBe(7);
      expect(policy.needsUnreadCount(message)).toBe(true);
    });

    it('passes an explicit badge straight through, and needs no count to do it', () => {
      const explicit: PushIntent = { ...message, badge: 0 };
      expect(policy.resolve(explicit, prefs(), 99)?.badge).toBe(0);
      expect(policy.needsUnreadCount(explicit)).toBe(false);
    });

    it('leaves the badge alone when the producer did not ask for one', () => {
      const noBadge: PushIntent = { ...message, badge: undefined };
      expect(policy.resolve(noBadge, prefs(), 5)?.badge).toBeUndefined();
    });
  });
});
