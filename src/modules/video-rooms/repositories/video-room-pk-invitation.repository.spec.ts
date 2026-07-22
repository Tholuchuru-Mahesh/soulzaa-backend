import { VideoRoomPkInvitationStatus } from '@prisma/client';
import { VideoRoomPkInvitationRepository } from './video-room-pk-invitation.repository';

const prisma = () =>
  ({
    videoRoomPkInvitation: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  }) as never;

describe('VideoRoomPkInvitationRepository', () => {
  // The status transition MUST be conditional on the expected from-status, or
  // a stale retry could clobber a response the invitee already gave.
  it('updateStatus guards on the expected from-status', async () => {
    const db = prisma();
    const repo = new VideoRoomPkInvitationRepository(db);
    const inv = (db as never as { videoRoomPkInvitation: { updateMany: jest.Mock } })
      .videoRoomPkInvitation;
    inv.updateMany.mockResolvedValue({ count: 0 });

    const out = await repo.updateStatus(
      'i1',
      VideoRoomPkInvitationStatus.SENT,
      VideoRoomPkInvitationStatus.ACCEPTED,
    );

    expect(inv.updateMany).toHaveBeenCalledWith({
      where: { id: 'i1', status: VideoRoomPkInvitationStatus.SENT },
      data: expect.objectContaining({ status: VideoRoomPkInvitationStatus.ACCEPTED }),
    });
    expect(out).toBeNull();
  });

  // SENT and DELIVERED are the only two states a user can still respond from;
  // ordering by attempt desc means a retry supersedes its predecessor.
  it('findActionable only matches SENT or DELIVERED', async () => {
    const db = prisma();
    const repo = new VideoRoomPkInvitationRepository(db);
    const inv = (db as never as { videoRoomPkInvitation: { findFirst: jest.Mock } })
      .videoRoomPkInvitation;
    inv.findFirst.mockResolvedValue(null);

    await repo.findActionable('b1', 'u1');

    expect(inv.findFirst).toHaveBeenCalledWith({
      where: {
        battleId: 'b1',
        inviteeUserId: 'u1',
        status: { in: [VideoRoomPkInvitationStatus.SENT, VideoRoomPkInvitationStatus.DELIVERED] },
      },
      orderBy: { attempt: 'desc' },
    });
  });
});
