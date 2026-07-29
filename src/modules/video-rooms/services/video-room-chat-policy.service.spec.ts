import { HttpStatus } from '@nestjs/common';
import {
  VideoRoomChatMode,
  VideoRoomMemberRole,
  VideoRoomMessageType,
  VideoRoomStatus,
} from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatPolicyService } from './video-room-chat-policy.service';

const ROOM = { id: 'r1', ownerId: 'owner-1', status: VideoRoomStatus.LIVE };
const CFG = { messageMaxLength: 500, editWindowSeconds: 900, recallWindowSeconds: 120 };

function settings(over: Partial<Record<string, unknown>> = {}) {
  return {
    roomId: 'r1',
    allowChat: true,
    allowViewerChat: true,
    chatMode: VideoRoomChatMode.NORMAL,
    chatMaxMessageLength: 500,
    chatMaxAttachments: 1,
    chatRateLimitPerMinute: 20,
    slowModeSeconds: 0,
    ...over,
  };
}

const actor = (id: string): RoomActor => ({ id, roles: [] });
const TEXT = {
  type: VideoRoomMessageType.TEXT,
  contentLength: 5,
  attachmentCount: 0,
};

describe('VideoRoomChatPolicyService', () => {
  let rooms: {
    findById: jest.Mock;
    getSettings: jest.Mock;
    requireSettings: jest.Mock;
    getMember: jest.Mock;
  };
  let permissions: { resolveEffectiveRole: jest.Mock };
  let moderation: { isActivelyMuted: jest.Mock; isActivelyBlocked: jest.Mock };
  let config: { get: jest.Mock };
  let policy: VideoRoomChatPolicyService;

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue(ROOM),
      getSettings: jest.fn().mockResolvedValue(settings()),
      // Mirrors `getSettings` by default (delegates to it) so every test that
      // overrides `getSettings` keeps working now that the service reads
      // `requireSettings` instead; tests targeting the missing-row path
      // override this mock directly.
      requireSettings: jest.fn(),
      getMember: jest.fn().mockResolvedValue({ isActive: true }),
    };
    rooms.requireSettings.mockImplementation(async () => {
      const row = await rooms.getSettings();
      if (!row) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
          'Room settings are missing.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return row;
    });
    permissions = {
      resolveEffectiveRole: jest.fn().mockResolvedValue(VideoRoomMemberRole.VIEWER),
    };
    moderation = {
      isActivelyMuted: jest.fn().mockResolvedValue(false),
      isActivelyBlocked: jest.fn().mockResolvedValue(false),
    };
    config = { get: jest.fn().mockReturnValue(CFG) };
    policy = new VideoRoomChatPolicyService(
      rooms as never,
      permissions as never,
      moderation as never,
      config as never,
    );
  });

  // ---- Preconditions ----

  it('rejects when the room does not exist', async () => {
    rooms.findById.mockResolvedValue(null);
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
    });
  });

  it('rejects when the room is not live', async () => {
    rooms.findById.mockResolvedValue({ ...ROOM, status: VideoRoomStatus.ENDED });
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_ENDED,
    });
  });

  it('rejects a non-member', async () => {
    rooms.getMember.mockResolvedValue(null);
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
    });
  });

  it('rejects an inactive member', async () => {
    rooms.getMember.mockResolvedValue({ isActive: false });
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
    });
  });

  it('rejects when chat is disabled, even for the owner', async () => {
    rooms.getSettings.mockResolvedValue(settings({ allowChat: false }));
    rooms.requireSettings.mockResolvedValue(settings({ allowChat: false }));
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.OWNER);
    await expect(policy.assertCanSend(actor('owner-1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.CHAT_DISABLED,
    });
  });

  // Guard hardening: a missing settings row must NOT read as "allowed".
  it('raises VIDEO_ROOM_SETTINGS_MISSING when the settings row is absent', async () => {
    rooms.requireSettings.mockRejectedValue(
      new BusinessException(
        ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
        'Room settings are missing.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      ),
    );
    await expect(policy.assertCanSend(actor('owner-1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
    });
  });

  it('rejects a blocked user', async () => {
    moderation.isActivelyBlocked.mockResolvedValue(true);
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_BLOCKED,
    });
  });

  it('rejects a muted user', async () => {
    moderation.isActivelyMuted.mockResolvedValue(true);
    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.MEMBER_MUTED,
    });
  });

  // ---- Content bounds ----

  it('rejects an over-length message', async () => {
    await expect(
      policy.assertCanSend(actor('u1'), 'r1', { ...TEXT, contentLength: 501 }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.MESSAGE_TOO_LONG });
  });

  it('rejects an empty message', async () => {
    await expect(
      policy.assertCanSend(actor('u1'), 'r1', { ...TEXT, contentLength: 0 }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.MESSAGE_TOO_LONG });
  });

  it('applies the tighter emoji bound', async () => {
    await expect(
      policy.assertCanSend(actor('u1'), 'r1', {
        type: VideoRoomMessageType.EMOJI,
        contentLength: 65,
        attachmentCount: 0,
      }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.MESSAGE_TOO_LONG });
  });

  it('rejects too many attachments', async () => {
    await expect(
      policy.assertCanSend(actor('u1'), 'r1', { ...TEXT, attachmentCount: 2 }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_ATTACHMENT_LIMIT });
  });

  it('refuses a client-supplied SYSTEM message', async () => {
    // SYSTEM rows are minted by the platform only; accepting one from a client
    // would let any member forge "Owner changed" notices.
    await expect(
      policy.assertCanSend(actor('u1'), 'r1', { ...TEXT, type: VideoRoomMessageType.SYSTEM }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_CHAT_MODE_RESTRICTED });
  });

  // ---- The mode × role matrix ----

  const ROLES = [
    VideoRoomMemberRole.OWNER,
    VideoRoomMemberRole.ADMIN,
    VideoRoomMemberRole.MODERATOR,
    VideoRoomMemberRole.HOST,
    VideoRoomMemberRole.PARTICIPANT,
    VideoRoomMemberRole.VIEWER,
  ];

  // true ⇒ a plain TEXT message is allowed.
  const MATRIX: Record<string, Record<string, boolean>> = {
    [VideoRoomChatMode.NORMAL]: {
      OWNER: true,
      ADMIN: true,
      MODERATOR: true,
      HOST: true,
      PARTICIPANT: true,
      VIEWER: true,
    },
    [VideoRoomChatMode.PARTICIPANTS_ONLY]: {
      OWNER: true,
      ADMIN: true,
      MODERATOR: true,
      HOST: true,
      PARTICIPANT: true,
      VIEWER: false,
    },
    [VideoRoomChatMode.READ_ONLY]: {
      OWNER: true,
      ADMIN: true,
      MODERATOR: true,
      HOST: false,
      PARTICIPANT: false,
      VIEWER: false,
    },
    // ANNOUNCEMENT_ONLY bars TEXT from everyone — even the owner, who must
    // send an ANNOUNCEMENT instead.
    [VideoRoomChatMode.ANNOUNCEMENT_ONLY]: {
      OWNER: false,
      ADMIN: false,
      MODERATOR: false,
      HOST: false,
      PARTICIPANT: false,
      VIEWER: false,
    },
  };

  for (const mode of Object.keys(MATRIX)) {
    for (const role of ROLES) {
      const allowed = MATRIX[mode][role];
      it(`${mode} × ${role} ${allowed ? 'allows' : 'rejects'} a text message`, async () => {
        rooms.getSettings.mockResolvedValue(settings({ chatMode: mode }));
        permissions.resolveEffectiveRole.mockResolvedValue(role);

        const send = policy.assertCanSend(actor('u1'), 'r1', TEXT);
        if (allowed) {
          await expect(send).resolves.toMatchObject({ role });
        } else {
          await expect(send).rejects.toMatchObject({
            errorCode: ERROR_CODES.VIDEO_ROOM_CHAT_MODE_RESTRICTED,
          });
        }
      });
    }
  }

  it('ANNOUNCEMENT_ONLY admits an ANNOUNCEMENT from an elevated role', async () => {
    rooms.getSettings.mockResolvedValue(
      settings({ chatMode: VideoRoomChatMode.ANNOUNCEMENT_ONLY }),
    );
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.ADMIN);

    await expect(
      policy.assertCanSend(actor('u1'), 'r1', {
        type: VideoRoomMessageType.ANNOUNCEMENT,
        contentLength: 10,
        attachmentCount: 0,
      }),
    ).resolves.toBeDefined();
  });

  it('ignores allowViewerChat entirely — chatMode is the only source of truth', async () => {
    // The deprecated column must never affect a decision, in either direction.
    rooms.getSettings.mockResolvedValue(
      settings({ allowViewerChat: false, chatMode: VideoRoomChatMode.NORMAL }),
    );
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.VIEWER);

    await expect(policy.assertCanSend(actor('u1'), 'r1', TEXT)).resolves.toBeDefined();
  });

  it('platform admins bypass every mode restriction', async () => {
    rooms.getSettings.mockResolvedValue({
      ...settings({ chatMode: VideoRoomChatMode.READ_ONLY }),
    });
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.VIEWER);

    await expect(
      policy.assertCanSend({ id: 'staff', roles: ['ADMIN'] as never }, 'r1', TEXT),
    ).resolves.toBeDefined();
  });

  // ---- Edit / delete / recall ----

  const own = {
    id: 'm1',
    roomId: 'r1',
    senderId: 'u1',
    type: VideoRoomMessageType.TEXT,
    createdAt: new Date(),
    deletedAt: null,
    recalledAt: null,
  };

  it('lets an author edit inside the window', async () => {
    await expect(policy.assertCanEdit(actor('u1'), 'r1', own as never)).resolves.toBeUndefined();
  });

  it('refuses an edit by anyone but the author', async () => {
    await expect(policy.assertCanEdit(actor('u2'), 'r1', own as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
    });
  });

  it('refuses an edit after the window closes', async () => {
    const old = { ...own, createdAt: new Date(Date.now() - 901_000) };
    await expect(policy.assertCanEdit(actor('u1'), 'r1', old as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_MESSAGE_EDIT_WINDOW_EXPIRED,
    });
  });

  it('refuses editing a SYSTEM message', async () => {
    const sys = { ...own, type: VideoRoomMessageType.SYSTEM };
    await expect(policy.assertCanEdit(actor('u1'), 'r1', sys as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_MESSAGE_NOT_EDITABLE,
    });
  });

  it('refuses editing a deleted message', async () => {
    const gone = { ...own, deletedAt: new Date() };
    await expect(policy.assertCanEdit(actor('u1'), 'r1', gone as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_MESSAGE_NOT_EDITABLE,
    });
  });

  it('lets the author delete their own message, not as a moderator', async () => {
    await expect(policy.assertCanDelete(actor('u1'), 'r1', own as never)).resolves.toEqual({
      byModerator: false,
    });
  });

  it('lets a moderator delete someone else’s message', async () => {
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.MODERATOR);
    await expect(policy.assertCanDelete(actor('mod'), 'r1', own as never)).resolves.toEqual({
      byModerator: true,
    });
  });

  it('refuses a non-moderator deleting someone else’s message', async () => {
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.VIEWER);
    await expect(policy.assertCanDelete(actor('u2'), 'r1', own as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
    });
  });

  it('refuses a recall after the window, even for the author', async () => {
    const old = { ...own, createdAt: new Date(Date.now() - 121_000) };
    await expect(policy.assertCanRecall(actor('u1'), 'r1', old as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_MESSAGE_RECALL_WINDOW_EXPIRED,
    });
  });

  it('refuses a recall by a moderator — recall is the author’s alone', async () => {
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.MODERATOR);
    await expect(policy.assertCanRecall(actor('mod'), 'r1', own as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
    });
  });
});
