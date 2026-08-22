import { PlatformRole } from '@prisma/client';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ModerationController } from './moderation.controller';

const user = { id: 'u1', roles: [PlatformRole.USER] } as unknown as AuthenticatedUser;
const ROOM = 'r1';

describe('ModerationController — banGlobally (platform-wide 24h ban)', () => {
  let moderation: any;
  let platformBans: any;
  let broadBans: any;
  let permissions: any;
  let subject: ModerationController;

  beforeEach(() => {
    moderation = { forceDisconnect: jest.fn().mockResolvedValue(undefined) };
    platformBans = { banUser: jest.fn().mockResolvedValue({ id: 'ban-1' }) };
    broadBans = { banBroad: jest.fn().mockResolvedValue({ id: 'bb-1' }) };
    permissions = { assertCanModerate: jest.fn().mockResolvedValue(undefined) };
    subject = new ModerationController(moderation, platformBans, broadBans, permissions);
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

describe('ModerationController — broadBan', () => {
  let moderation: any;
  let platformBans: any;
  let permissions: any;
  let broadBans: any;
  let subject: ModerationController;

  beforeEach(() => {
    moderation = { forceDisconnect: jest.fn().mockResolvedValue(undefined) };
    platformBans = { banUser: jest.fn().mockResolvedValue({ id: 'ban-1' }) };
    broadBans = { banBroad: jest.fn().mockResolvedValue({ id: 'bb-1' }) };
    permissions = { assertCanModerate: jest.fn().mockResolvedValue(undefined) };
    subject = new ModerationController(moderation, platformBans, broadBans, permissions);
  });

  it('delegates to BroadBanService.banBroad with the room id, moderator id, and DTO fields', async () => {
    const result = await subject.broadBan(
      { id: 'mod-1', roles: ['MODERATOR'] } as never,
      'room-1',
      { reason: 'abuse', description: 'repeated abuse', proofUrl: 'https://x/proof.png' } as never,
    );

    expect(permissions.assertCanModerate).toHaveBeenCalledWith('room-1', {
      id: 'mod-1',
      roles: ['MODERATOR'],
    });
    expect(broadBans.banBroad).toHaveBeenCalledWith({
      moderatorId: 'mod-1',
      roomId: 'room-1',
      roomType: 'AUDIO_ROOM',
      reason: 'abuse',
      description: 'repeated abuse',
      proofUrl: 'https://x/proof.png',
    });
    expect(result.id).toBe('bb-1');
  });
});
