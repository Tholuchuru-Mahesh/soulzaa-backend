import { PlatformRole } from '@prisma/client';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ModerationController } from './moderation.controller';

const user = { id: 'u1', roles: [PlatformRole.USER] } as unknown as AuthenticatedUser;
const ROOM = 'r1';

describe('ModerationController — banGlobally (platform-wide 24h ban)', () => {
  let moderation: any;
  let platformBans: any;
  let permissions: any;
  let subject: ModerationController;

  beforeEach(() => {
    moderation = { forceDisconnect: jest.fn().mockResolvedValue(undefined) };
    platformBans = { banUser: jest.fn().mockResolvedValue({ id: 'ban-1' }) };
    permissions = { assertCanModerate: jest.fn().mockResolvedValue(undefined) };
    subject = new ModerationController(moderation, platformBans, permissions);
  });

  it('requires moderation authorization on THIS room before issuing the ban', async () => {
    const dto = { reason: 'harassment' } as never;
    await subject.banGlobally(user, ROOM, 't1', dto);

    expect(permissions.assertCanModerate).toHaveBeenCalledWith(ROOM, {
      id: 'u1',
      roles: [PlatformRole.USER],
    });
    expect(platformBans.banUser).toHaveBeenCalledWith({
      moderatorId: 'u1',
      targetUserId: 't1',
      reason: 'harassment',
      roomType: 'AUDIO_ROOM',
      originRoomId: ROOM,
    });
  });

  it('a non-moderator is rejected before the ban is ever issued', async () => {
    permissions.assertCanModerate.mockRejectedValueOnce(new Error('forbidden'));
    const dto = { reason: 'harassment' } as never;

    await expect(subject.banGlobally(user, ROOM, 't1', dto)).rejects.toThrow('forbidden');
    expect(platformBans.banUser).not.toHaveBeenCalled();
  });
});
