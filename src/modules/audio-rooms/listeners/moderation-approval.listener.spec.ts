import { ModerationBanType } from '@prisma/client';
import { AudioRoomModerationApprovalListener } from './moderation-approval.listener';
import { MODERATION_APPROVAL_EVENTS } from 'src/modules/moderation-approval/events/moderation-approval.events';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => unknown> = {};
  const bus = {
    subscribe: (n: string, h: (e: unknown) => unknown) => {
      handlers[n] = h;
      return () => undefined;
    },
    publish: jest.fn(),
  };
  const moderation = { ban: jest.fn().mockResolvedValue(undefined) };
  const roles = { getRoleNames: jest.fn().mockResolvedValue(['MODERATOR']) };
  new AudioRoomModerationApprovalListener(bus as never, moderation as never, roles as never).onModuleInit();
  return { handlers, moderation, roles };
}

const BASE_PAYLOAD = {
  approvalId: 'approval-1',
  roomType: 'AUDIO_ROOM',
  roomId: 'room-1',
  liveStreamId: null,
  reportId: 'report-1',
  proposedBy: 'mod-1',
  targetUserId: 'target-1',
  action: 'BAN',
  reason: 'harassment',
  decidedBy: 'official-1',
};

describe('AudioRoomModerationApprovalListener', () => {
  it('executes a PERMANENT ban when an AUDIO_ROOM approval is approved', async () => {
    const d = makeDeps();
    await d.handlers[MODERATION_APPROVAL_EVENTS.APPROVED]({ payload: BASE_PAYLOAD });

    expect(d.roles.getRoleNames).toHaveBeenCalledWith('mod-1');
    expect(d.moderation.ban).toHaveBeenCalledWith(
      { id: 'mod-1', roles: ['MODERATOR'] },
      'room-1',
      'target-1',
      { type: ModerationBanType.PERMANENT, reason: 'harassment' },
    );
  });

  it('ignores approvals for other room types', async () => {
    const d = makeDeps();
    await d.handlers[MODERATION_APPROVAL_EVENTS.APPROVED]({
      payload: { ...BASE_PAYLOAD, roomType: 'VIDEO_ROOM' },
    });
    expect(d.moderation.ban).not.toHaveBeenCalled();
  });

  it('swallows execution errors rather than crashing the event bus', async () => {
    const d = makeDeps();
    d.moderation.ban.mockRejectedValue(new Error('room already closed'));
    await expect(
      d.handlers[MODERATION_APPROVAL_EVENTS.APPROVED]({ payload: BASE_PAYLOAD }),
    ).resolves.toBeUndefined();
  });
});
