import { VideoRoomChatMode, type VideoRoomSettings } from '@prisma/client';
import { toSettingsView } from './video-room-detail.mapper';
import { WRITABLE_SETTINGS_FIELDS } from '../services/video-room-settings.service';

/**
 * A complete settings row. Values are deliberately the OPPOSITE of each
 * column's Prisma default, so a field the mapper forgets to project cannot be
 * masked by the reader's fallback happening to match.
 */
function settingsRow(): VideoRoomSettings {
  return {
    roomId: 'room-1',
    allowChat: false,
    allowViewerChat: false,
    chatMode: VideoRoomChatMode.NORMAL,
    chatMaxMessageLength: 500,
    chatMaxAttachments: 1,
    chatRateLimitPerMinute: 20,
    slowModeSeconds: 30,
    allowGifts: false,
    allowTreasure: false,
    allowPk: false,
    allowBeauty: false,
    allowCameraSwitch: false,
    allowScreenShare: true,
    allowRecording: true,
    joinApprovalRequired: true,
    allowJoinRequest: false,
    allowShare: false,
    allowInvite: false,
    allowFollow: false,
    allowReporting: false,
    allowAnnouncements: false,
    isRoomMuted: true,
    maxDurationMinutes: 120,
    hostSeatCount: 6,
    guestSeatCount: 2,
    seatApprovalRequired: false,
    metadata: null,
    createdAt: new Date('2026-07-24T00:00:00.000Z'),
    updatedAt: new Date('2026-07-24T00:00:00.000Z'),
  } as VideoRoomSettings;
}

describe('toSettingsView', () => {
  it('returns null for a missing settings row', () => {
    expect(toSettingsView(null)).toBeNull();
  });

  /**
   * THE contract test. This view is the payload of the
   * `video_room.settings_updated` broadcast, so any field `PATCH :id/settings`
   * can write MUST appear in it. A writable-but-unprojected field is silently
   * reset to its client default on every client that reconciles from the
   * broadcast — which is exactly how `seatApprovalRequired` regressed.
   *
   * Driven off WRITABLE_SETTINGS_FIELDS rather than a hand-copied list, so
   * making a new field writable without projecting it fails here immediately.
   */
  it('projects every field the settings endpoint can write', () => {
    const view = toSettingsView(settingsRow());
    expect(view).not.toBeNull();

    for (const field of WRITABLE_SETTINGS_FIELDS) {
      expect(view).toHaveProperty(field);
      expect((view as unknown as Record<string, unknown>)[field]).toBeDefined();
    }
  });

  it('carries the row values through unchanged', () => {
    const view = toSettingsView(settingsRow());

    expect(view).toMatchObject({
      allowChat: false,
      slowModeSeconds: 30,
      allowGifts: false,
      allowTreasure: false,
      allowPk: false,
      allowBeauty: false,
      allowCameraSwitch: false,
      allowInvite: false,
      allowReporting: false,
      allowAnnouncements: false,
      seatApprovalRequired: false,
      hostSeatCount: 6,
      guestSeatCount: 2,
      maxDurationMinutes: 120,
    });
  });

  it('does not leak internal chat-tuning or audit columns', () => {
    const view = toSettingsView(settingsRow()) as unknown as Record<string, unknown>;

    for (const internal of [
      'roomId',
      'chatMode',
      'chatMaxMessageLength',
      'chatMaxAttachments',
      'chatRateLimitPerMinute',
      'metadata',
      'createdAt',
      'updatedAt',
    ]) {
      expect(view).not.toHaveProperty(internal);
    }
  });
});
