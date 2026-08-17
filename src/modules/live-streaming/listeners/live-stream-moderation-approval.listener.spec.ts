import { LiveStreamModerationApprovalListener } from './live-stream-moderation-approval.listener';
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
  const liveStream = { moderateUser: jest.fn().mockResolvedValue(undefined) };
  new LiveStreamModerationApprovalListener(bus as never, liveStream as never).onModuleInit();
  return { handlers, liveStream };
}

const BASE_PAYLOAD = {
  approvalId: 'approval-1',
  roomType: 'LIVE_STREAM',
  roomId: null,
  liveStreamId: 'stream-1',
  reportId: 'report-1',
  proposedBy: 'mod-1',
  targetUserId: 'target-1',
  action: 'BAN',
  reason: 'harassment',
  decidedBy: 'official-1',
};

describe('LiveStreamModerationApprovalListener', () => {
  it('executes the ban when a LIVE_STREAM approval is approved', async () => {
    const d = makeDeps();
    await d.handlers[MODERATION_APPROVAL_EVENTS.APPROVED]({ payload: BASE_PAYLOAD });

    expect(d.liveStream.moderateUser).toHaveBeenCalledWith({
      streamId: 'stream-1',
      moderatorId: 'mod-1',
      targetUserId: 'target-1',
      action: 'BAN',
      reason: 'harassment',
    });
  });

  it('ignores approvals for other room types', async () => {
    const d = makeDeps();
    await d.handlers[MODERATION_APPROVAL_EVENTS.APPROVED]({
      payload: { ...BASE_PAYLOAD, roomType: 'AUDIO_ROOM' },
    });
    expect(d.liveStream.moderateUser).not.toHaveBeenCalled();
  });

  it('swallows execution errors rather than crashing the event bus', async () => {
    const d = makeDeps();
    d.liveStream.moderateUser.mockRejectedValue(new Error('stream already ended'));
    await expect(
      d.handlers[MODERATION_APPROVAL_EVENTS.APPROVED]({ payload: BASE_PAYLOAD }),
    ).resolves.toBeUndefined();
  });
});
