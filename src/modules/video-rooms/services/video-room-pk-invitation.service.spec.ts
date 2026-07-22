import { ConfigService } from '@nestjs/config';
import { VideoRoomPkBattle, VideoRoomPkInvitationStatus, VideoRoomPkStatus } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { PKInvitationException } from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkInvitationRepository } from '../repositories/video-room-pk-invitation.repository';
import { VideoRoomPkStateService } from './video-room-pk-state.service';
import { VideoRoomPkInvitationService } from './video-room-pk-invitation.service';

const battle = (overrides: Partial<VideoRoomPkBattle> = {}): VideoRoomPkBattle =>
  ({
    id: 'b1',
    roomId: 'r1',
    mode: 'ONE_VS_ONE',
    status: VideoRoomPkStatus.PENDING,
    createdBy: 'owner',
    countdownSeconds: 10,
    durationSeconds: 300,
    startedAt: null,
    endsAt: null,
    pausedAt: null,
    totalPausedMs: 0,
    resumeSeq: 0,
    scoringSnapshot: {},
    rewardSnapshot: {},
    winningTeamId: null,
    isDraw: false,
    completedAt: null,
    cancelledAt: null,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as VideoRoomPkBattle;

describe('VideoRoomPkInvitationService', () => {
  let repo: jest.Mocked<VideoRoomPkInvitationRepository>;
  let state: jest.Mocked<VideoRoomPkStateService>;
  let bus: jest.Mocked<IEventBus>;
  let config: ConfigService;
  let svc: VideoRoomPkInvitationService;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockResolvedValue({ id: 'i1', attempt: 1 }),
      listForBattle: jest.fn().mockResolvedValue([]),
      findActionable: jest.fn().mockResolvedValue({
        id: 'i1',
        status: VideoRoomPkInvitationStatus.SENT,
        roomId: 'r1',
        targetRoomId: 'r1',
      }),
      updateStatus: jest.fn().mockResolvedValue({ id: 'i1' }),
      latestAttempt: jest.fn().mockResolvedValue(0),
      findExpired: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<VideoRoomPkInvitationRepository>;

    state = {
      transition: jest.fn(),
      tryTransition: jest.fn(),
      assertTransition: jest.fn(),
    } as unknown as jest.Mocked<VideoRoomPkStateService>;

    bus = { publish: jest.fn(), subscribe: jest.fn() } as unknown as jest.Mocked<IEventBus>;
    config = { get: jest.fn().mockReturnValue({}) } as unknown as ConfigService;

    svc = new VideoRoomPkInvitationService(repo, state, bus, config);
  });

  it('creates one row and one event per invitee', async () => {
    await svc.send(battle(), ['u1', 'u2'], 'owner');
    expect(repo.create).toHaveBeenCalledTimes(2);
    expect(bus.publish).toHaveBeenCalledTimes(2);
    expect(bus.publish.mock.calls[0][0].name).toBe(VIDEO_ROOM_PK_EVENTS.INVITATION_SENT);
  });

  it('stamps targetRoomId as the current room today', async () => {
    await svc.send(battle({ roomId: 'r1' }), ['u1'], 'owner');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r1', targetRoomId: 'r1' }),
      undefined,
    );
  });

  // Beyond the brief's 12: multiple invitees must each get THEIR OWN event,
  // not a shared/aliased payload from the last loop iteration.
  it('send publishes one event per invitee with the correct per-invitee payload', async () => {
    repo.create
      .mockResolvedValueOnce({ id: 'i1', attempt: 1 } as never)
      .mockResolvedValueOnce({ id: 'i2', attempt: 1 } as never);

    await svc.send(battle({ roomId: 'r1' }), ['u1', 'u2'], 'owner');

    expect(bus.publish.mock.calls[0][0].payload).toEqual(
      expect.objectContaining({
        roomId: 'r1',
        battleId: 'b1',
        invitationId: 'i1',
        inviteeUserId: 'u1',
        inviterUserId: 'owner',
      }),
    );
    expect(bus.publish.mock.calls[1][0].payload).toEqual(
      expect.objectContaining({
        roomId: 'r1',
        battleId: 'b1',
        invitationId: 'i2',
        inviteeUserId: 'u2',
        inviterUserId: 'owner',
      }),
    );
  });

  it('markDelivered moves the battle INVITED → PENDING', async () => {
    repo.findActionable.mockResolvedValue({ id: 'i1', status: 'SENT' } as never);
    await svc.markDelivered(battle({ status: VideoRoomPkStatus.INVITED }), 'u1');
    expect(state.transition).toHaveBeenCalledWith(
      'b1',
      VideoRoomPkStatus.INVITED,
      VideoRoomPkStatus.PENDING,
    );
  });

  it('markDelivered is idempotent for an already-PENDING battle', async () => {
    repo.findActionable.mockResolvedValue({ id: 'i1', status: 'DELIVERED' } as never);
    await svc.markDelivered(battle({ status: VideoRoomPkStatus.PENDING }), 'u1');
    expect(state.transition).not.toHaveBeenCalled();
  });

  // Authority is being the named invitee — a row lookup, NOT a permission.
  it('refuses an accept from someone with no invitation', async () => {
    repo.findActionable.mockResolvedValue(null);
    await expect(svc.accept('stranger', battle())).rejects.toThrow(PKInvitationException);
  });

  it('does not advance the battle while another invitee is outstanding', async () => {
    repo.updateStatus.mockResolvedValue({ id: 'i1' } as never);
    repo.listForBattle.mockResolvedValue([
      { id: 'i1', status: VideoRoomPkInvitationStatus.ACCEPTED },
      { id: 'i2', status: VideoRoomPkInvitationStatus.SENT },
    ] as never);
    await svc.accept('u1', battle());
    expect(state.transition).not.toHaveBeenCalled();
  });

  it('advances to ACCEPTED once nothing is actionable', async () => {
    repo.updateStatus.mockResolvedValue({ id: 'i1' } as never);
    repo.listForBattle.mockResolvedValue([
      { id: 'i1', status: VideoRoomPkInvitationStatus.ACCEPTED },
    ] as never);
    await svc.accept('u1', battle({ status: VideoRoomPkStatus.PENDING }));
    expect(state.transition).toHaveBeenCalledWith(
      'b1',
      VideoRoomPkStatus.PENDING,
      VideoRoomPkStatus.ACCEPTED,
    );
  });

  it('a double-tapped accept records once', async () => {
    repo.updateStatus.mockResolvedValue(null); // conditional update lost
    await svc.accept('u1', battle());
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('reject cancels the battle when nothing actionable remains', async () => {
    repo.updateStatus.mockResolvedValue({ id: 'i1' } as never);
    repo.listForBattle.mockResolvedValue([
      { id: 'i1', status: VideoRoomPkInvitationStatus.REJECTED },
    ] as never);
    await svc.reject('u1', battle());
    expect(state.transition).toHaveBeenCalledWith(
      'b1',
      expect.anything(),
      VideoRoomPkStatus.CANCELLED,
      expect.anything(),
    );
  });

  it('retry creates attempt + 1', async () => {
    repo.latestAttempt.mockResolvedValue(1);
    repo.findActionable.mockResolvedValue({
      id: 'i1',
      status: VideoRoomPkInvitationStatus.SENT,
    } as never);
    await svc.retry('b1', 'u1', 'owner');
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2 }), undefined);
  });

  // You retry an invitation the client never acknowledged. One it DID
  // acknowledge is simply unanswered — resending would spam the invitee.
  it('refuses to retry a DELIVERED invitation', async () => {
    repo.findActionable.mockResolvedValue({
      id: 'i1',
      status: VideoRoomPkInvitationStatus.DELIVERED,
    } as never);
    await expect(svc.retry('b1', 'u1', 'owner')).rejects.toThrow(PKInvitationException);
  });

  it('expireDue expires past-TTL rows', async () => {
    repo.findExpired.mockResolvedValue([{ id: 'i1', battleId: 'b1', status: 'SENT' }] as never);
    await svc.expireDue(new Date(), 50);
    expect(repo.updateStatus).toHaveBeenCalledWith(
      'i1',
      'SENT',
      VideoRoomPkInvitationStatus.EXPIRED,
      expect.anything(),
    );
  });

  // Beyond the brief's 12: a battle with one invitee still SENT/DELIVERED
  // must NOT be cancelled just because a DIFFERENT invitee's row expired.
  it('expireDue leaves the battle alone when some invitation is still actionable', async () => {
    repo.findExpired.mockResolvedValue([
      { id: 'i1', battleId: 'b1', status: VideoRoomPkInvitationStatus.SENT },
    ] as never);
    repo.listForBattle.mockResolvedValue([
      { id: 'i1', status: VideoRoomPkInvitationStatus.EXPIRED },
      { id: 'i2', status: VideoRoomPkInvitationStatus.SENT },
    ] as never);
    await svc.expireDue(new Date(), 50);
    expect(state.tryTransition).not.toHaveBeenCalled();
  });

  // Beyond the brief's 12: nothing left to cancel is a no-op, not a
  // needless write to every already-resolved invitation.
  it('cancelAll is a no-op on an already-terminal battle', async () => {
    repo.listForBattle.mockResolvedValue([
      { id: 'i1', status: VideoRoomPkInvitationStatus.ACCEPTED },
      { id: 'i2', status: VideoRoomPkInvitationStatus.REJECTED },
    ] as never);
    await svc.cancelAll('b1', 'battle ended');
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });
});
