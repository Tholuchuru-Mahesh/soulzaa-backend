import { VideoRoomJoinPolicy } from './video-room-join.policy';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';

describe('VideoRoomJoinPolicy', () => {
  const ROOM_ID = '11111111-1111-4111-8111-111111111111';
  const HOST_ID = '22222222-2222-4222-8222-222222222222';
  const MOD_ID = '33333333-3333-4333-8333-333333333333';
  const STRANGER_ID = '44444444-4444-4444-8444-444444444444';
  const GRANTED_VIEWER_ID = '55555555-5555-4555-8555-555555555555';
  const ACTIVE_MEMBER_ID = '66666666-6666-4666-8666-666666666666';
  const SESSION_ID = 'session-1';

  let registry: Map<string, any>;
  let repo: {
    findById: jest.Mock;
    getMember: jest.Mock;
    getActiveBroadcastSession: jest.Mock;
  };
  let giftLockAccessRepo: {
    hasGrantedAccess: jest.Mock;
  };
  let prisma: {
    user: { findUnique: jest.Mock };
  };
  let policy: VideoRoomJoinPolicy;

  beforeEach(() => {
    registry = new Map();
    repo = {
      findById: jest.fn().mockResolvedValue({
        id: ROOM_ID,
        status: 'LIVE',
        ownerId: HOST_ID,
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-rose',
      }),
      getMember: jest.fn().mockImplementation((_roomId: string, userId: string) => {
        if (userId === ACTIVE_MEMBER_ID) {
          return Promise.resolve({ userId, isActive: true });
        }
        return Promise.resolve(null);
      }),
      getActiveBroadcastSession: jest.fn().mockResolvedValue({
        id: SESSION_ID,
        status: 'LIVE',
      }),
    };
    giftLockAccessRepo = {
      hasGrantedAccess: jest.fn().mockImplementation((userId: string, sessionId: string) => {
        return Promise.resolve(userId === GRANTED_VIEWER_ID && sessionId === SESSION_ID);
      }),
    };
    prisma = {
      user: {
        findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
          if (where.id === MOD_ID) {
            return Promise.resolve({ id: MOD_ID, roles: ['MODERATOR'] });
          }
          return Promise.resolve({ id: where.id, roles: [] });
        }),
      },
    };

    policy = new VideoRoomJoinPolicy(
      registry as any,
      repo as any,
      giftLockAccessRepo as any,
      prisma as any,
    );
  });

  it('registers itself for VIDEO_ROOM_NAMESPACE on init', () => {
    policy.onModuleInit();
    expect(registry.get(VIDEO_ROOM_NAMESPACE)).toBe(policy);
  });

  it('allows join unconditionally when gift-lock is disabled', async () => {
    repo.findById.mockResolvedValue({
      id: ROOM_ID,
      status: 'LIVE',
      ownerId: HOST_ID,
      giftLockEnabled: false,
    });
    await expect(policy.canJoin(STRANGER_ID, ROOM_ID)).resolves.toBe('player');
  });

  it('denies join if room is not LIVE or not found', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(policy.canJoin(STRANGER_ID, ROOM_ID)).resolves.toBe('deny');

    repo.findById.mockResolvedValue({
      id: ROOM_ID,
      status: 'ENDED',
      ownerId: HOST_ID,
      giftLockEnabled: true,
    });
    await expect(policy.canJoin(STRANGER_ID, ROOM_ID)).resolves.toBe('deny');
  });

  it('denies malformed UUID roomIds immediately', async () => {
    await expect(policy.canJoin(STRANGER_ID, 'not-a-uuid')).resolves.toBe('deny');
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('allows the room owner/host through a gift-locked room', async () => {
    await expect(policy.canJoin(HOST_ID, ROOM_ID)).resolves.toBe('player');
  });

  it('allows moderators/staff through a gift-locked room without a gift', async () => {
    await expect(policy.canJoin(MOD_ID, ROOM_ID)).resolves.toBe('player');
  });

  it('allows an already-active member without re-prompting', async () => {
    await expect(policy.canJoin(ACTIVE_MEMBER_ID, ROOM_ID)).resolves.toBe('player');
  });

  it('allows a viewer who has granted gift-lock access for the current session', async () => {
    await expect(policy.canJoin(GRANTED_VIEWER_ID, ROOM_ID)).resolves.toBe('player');
    expect(giftLockAccessRepo.hasGrantedAccess).toHaveBeenCalledWith(GRANTED_VIEWER_ID, SESSION_ID);
  });

  it('denies a stranger who has not sent the required entry gift', async () => {
    await expect(policy.canJoin(STRANGER_ID, ROOM_ID)).resolves.toBe('deny');
  });
});
