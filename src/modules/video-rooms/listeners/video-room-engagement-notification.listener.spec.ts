// src/modules/video-rooms/listeners/video-room-engagement-notification.listener.spec.ts
import { VideoRoomEngagementNotificationListener } from './video-room-engagement-notification.listener';
import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';

function makeDeps() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const bus = {
    subscribe: (n: string, h: (e: unknown) => void) => {
      handlers[n] = h;
      return () => undefined;
    },
    publish: jest.fn(),
  };
  const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
  new VideoRoomEngagementNotificationListener(bus as never, dispatcher as never).onModuleInit();
  return { handlers, dispatcher };
}

describe('VideoRoomEngagementNotificationListener', () => {
  it('treasure reward → TREASURE_REWARD to the recipient', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED]({
      payload: {
        roomId: 'r1',
        correlationId: 'c',
        sessionId: 's',
        userId: 'u1',
        amount: 50,
        walletTxnId: 'w1',
      },
    });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(
      K.TREASURE_REWARD,
      expect.objectContaining({ roomId: 'r1', targetUserIds: ['u1'] }),
    );
  });

  it('treasure unlocked → TREASURE_UNLOCKED to room members', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED]({
      payload: {
        roomId: 'r1',
        correlationId: 'c',
        sessionId: 's',
        poolAmount: 100,
        winners: [],
        algorithm: 'x',
        nextLevel: null,
      },
    });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(
      K.TREASURE_UNLOCKED,
      expect.objectContaining({ roomId: 'r1' }),
    );
  });

  it('pk invitation/accepted/rejected/winner map to their kinds', async () => {
    const d = makeDeps();
    await d.handlers[VIDEO_ROOM_PK_EVENTS.INVITATION_SENT]({
      payload: {
        roomId: 'r1',
        battleId: 'b1',
        invitationId: 'i',
        inviteeUserId: 'u1',
        inviterUserId: 'h1',
        side: 'A',
        attempt: 1,
        expiresAt: 'x',
      },
    });
    await d.handlers[VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED]({
      payload: { roomId: 'r1', battleId: 'b1', invitationId: 'i', inviteeUserId: 'u1' },
    });
    await d.handlers[VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED]({
      payload: { roomId: 'r1', battleId: 'b1', invitationId: 'i', inviteeUserId: 'u1' },
    });
    await d.handlers[VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED]({
      payload: {
        roomId: 'r1',
        battleId: 'b1',
        winningTeamId: 't1',
        isDraw: false,
        winners: ['u1', 'u2'],
      },
    });
    const kinds = d.dispatcher.dispatch.mock.calls.map((c: unknown[]) => c[0]);
    expect(kinds).toEqual([K.PK_INVITATION, K.PK_ACCEPTED, K.PK_REJECTION, K.PK_WINNER]);
    const winnerCall = d.dispatcher.dispatch.mock.calls.find(
      (c: unknown[]) => c[0] === K.PK_WINNER,
    )!;
    expect((winnerCall[1] as { targetUserIds: string[] }).targetUserIds).toEqual(['u1', 'u2']);
  });
});
