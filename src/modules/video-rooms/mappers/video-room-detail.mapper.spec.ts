import {
  VideoRoomChatMode,
  VideoRoomStatus,
  VideoRoomStreamingStatus,
  VideoRoomVisibility,
  type VideoRoomSettings,
} from '@prisma/client';
import { resolveRequiredEntryGift, toSettingsView, toVideoRoomDetailView } from './video-room-detail.mapper';
import { WRITABLE_SETTINGS_FIELDS } from '../services/video-room-settings.service';
import type { VideoRoomDetail } from '../repositories/video-rooms.repository';
import type { IGiftsService } from '../../gifts/interfaces/gifts.service.interface';

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
    });
  });

  it('does not leak internal chat-tuning or audit columns', () => {
    const view = toSettingsView(settingsRow()) as unknown as Record<string, unknown>;

    for (const internal of [
      'roomId',
      // chatMode / chatMaxMessageLength ARE projected now — see the test below.
      'chatMaxAttachments',
      'chatRateLimitPerMinute',
      'metadata',
      'createdAt',
      'updatedAt',
      // Retired 2026-07-29: stored but unenforced, so no longer advertised.
      // They return with their guards in sub-projects B and C.
      'allowScreenShare',
      'allowRecording',
      'allowViewerChat',
      'joinApprovalRequired',
      'allowJoinRequest',
      'allowShare',
      'allowFollow',
      'maxDurationMinutes',
    ]) {
      expect(view).not.toHaveProperty(internal);
    }
  });

  // The composer cannot behave correctly without these two: the room's own
  // message ceiling can be below the DTO's 4000-character bound, and the chat
  // mode decides whether to offer a composer at all. Withholding them forced
  // the client to hardcode both — which then went stale the moment an owner
  // changed either. Still enforced server-side; this is for the UI only.
  it('projects the chat policy the client has to render', () => {
    const view = toSettingsView(settingsRow());

    expect(view).toMatchObject({
      chatMode: expect.any(String),
      chatMaxMessageLength: expect.any(Number),
    });
  });

  // isRoomMuted is real as of the mute-all wiring; seat counts are real and
  // edited via the seats endpoint. All three must keep reaching the client.
  it('retains isRoomMuted and the seat layout', () => {
    const view = toSettingsView(settingsRow());

    expect(view).toMatchObject({
      isRoomMuted: expect.any(Boolean),
      hostSeatCount: 6,
      guestSeatCount: 2,
    });
  });
});

/**
 * Minimal valid room row for `toVideoRoomDetailView` (VideoRoomDetail['room']).
 * `giftLockEnabled`/`requiredEntryGiftId` default OFF; override per-test.
 */
function detailRoom(overrides: Record<string, unknown> = {}) {
  return {
    id: 'room-1',
    ownerId: 'owner-1',
    name: 'Room',
    description: null,
    imageKey: null,
    categoryId: null,
    language: null,
    country: null,
    tags: [],
    visibility: VideoRoomVisibility.PUBLIC,
    isLocked: false,
    isDiscoverable: true,
    isVerified: false,
    maxParticipants: 12,
    maxViewers: 500,
    status: VideoRoomStatus.OFFLINE,
    streamingStatus: VideoRoomStreamingStatus.IDLE,
    endedAt: null,
    deletedAt: null,
    metadata: null,
    createdAt: new Date('2026-07-24T00:00:00.000Z'),
    updatedAt: new Date('2026-07-24T00:00:00.000Z'),
    giftLockEnabled: false,
    requiredEntryGiftId: null,
    ...overrides,
  };
}

const requiredGift = {
  id: 'gift-1',
  name: 'Rose',
  thumbnailUrl: 'https://x/rose.png',
  coinValue: 10,
};

describe('toVideoRoomDetailView', () => {
  /**
   * The mobile client renders the settings toggle state and the "required
   * gift" dialog straight off this view (no second fetch), so both the raw
   * `giftLockEnabled` column and the resolved gift display info must ride
   * together on the same object.
   */
  it('includes the resolved required entry gift when gift-lock is enabled', () => {
    const detail: VideoRoomDetail = {
      room: detailRoom({ giftLockEnabled: true, requiredEntryGiftId: 'gift-1' }) as any,
      settings: null,
      statistics: null,
    };
    const view = toVideoRoomDetailView(detail, { requiredEntryGift: requiredGift });
    expect(view.giftLockEnabled).toBe(true);
    expect(view.requiredEntryGift).toEqual(requiredGift);
  });

  it('omits the required gift when gift-lock is disabled', () => {
    const detail: VideoRoomDetail = {
      room: detailRoom({ giftLockEnabled: false, requiredEntryGiftId: null }) as any,
      settings: null,
      statistics: null,
    };
    const view = toVideoRoomDetailView(detail, {});
    expect(view.giftLockEnabled).toBe(false);
    expect(view.requiredEntryGift).toBeNull();
  });

  it('defaults requiredEntryGift to null when no extras argument is passed at all', () => {
    const detail: VideoRoomDetail = {
      room: detailRoom() as any,
      settings: null,
      statistics: null,
    };
    const view = toVideoRoomDetailView(detail);
    expect(view.giftLockEnabled).toBe(false);
    expect(view.requiredEntryGift).toBeNull();
  });
});

/**
 * `resolveRequiredEntryGift` is the ONE place that turns
 * `giftLockEnabled`/`requiredEntryGiftId` into the display-ready gift object.
 * Both `VideoRoomQueryService.getDetail()` and
 * `VideoRoomLifecycleService`'s private `buildDetail()` call it before
 * invoking `toVideoRoomDetailView` — sharing it here means a fix to the
 * resolution rule (e.g. a deleted gift) lands in both call sites at once,
 * instead of the cache-refresh path silently drifting from the read path.
 */
describe('resolveRequiredEntryGift', () => {
  function giftsService(overrides: Partial<IGiftsService> = {}): IGiftsService {
    return {
      getGift: jest.fn().mockResolvedValue(null),
      isGiftEnabled: jest.fn(),
      listActiveGifts: jest.fn(),
      getContextCoinsInRange: jest.fn(),
      getTopFans: jest.fn(),
      ...overrides,
    } as unknown as IGiftsService;
  }

  it('returns null without calling the gifts service when gift-lock is disabled', async () => {
    const gifts = giftsService();
    const result = await resolveRequiredEntryGift(gifts, {
      giftLockEnabled: false,
      requiredEntryGiftId: 'gift-1',
    });
    expect(result).toBeNull();
    expect(gifts.getGift).not.toHaveBeenCalled();
  });

  it('returns null when gift-lock is enabled but no gift id is set', async () => {
    const gifts = giftsService();
    const result = await resolveRequiredEntryGift(gifts, {
      giftLockEnabled: true,
      requiredEntryGiftId: null,
    });
    expect(result).toBeNull();
    expect(gifts.getGift).not.toHaveBeenCalled();
  });

  it('resolves the gift display info when gift-lock is enabled and the gift exists', async () => {
    const gifts = giftsService({
      getGift: jest.fn().mockResolvedValue({
        id: 'gift-1',
        name: 'Rose',
        thumbnailUrl: 'https://x/rose.png',
        coinValue: 10,
      }),
    });
    const result = await resolveRequiredEntryGift(gifts, {
      giftLockEnabled: true,
      requiredEntryGiftId: 'gift-1',
    });
    expect(gifts.getGift).toHaveBeenCalledWith('gift-1');
    expect(result).toEqual({
      id: 'gift-1',
      name: 'Rose',
      thumbnailUrl: 'https://x/rose.png',
      coinValue: 10,
    });
  });

  it('returns null when the referenced gift no longer exists in the catalog', async () => {
    const gifts = giftsService({ getGift: jest.fn().mockResolvedValue(null) });
    const result = await resolveRequiredEntryGift(gifts, {
      giftLockEnabled: true,
      requiredEntryGiftId: 'gift-deleted',
    });
    expect(result).toBeNull();
  });
});
