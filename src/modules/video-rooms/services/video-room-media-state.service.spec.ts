import { VideoRoomMediaStateService } from './video-room-media-state.service';
import { MediaProviderKind, ConnectionType } from '../enums';

const cfg = { get: () => ({ stateTtlSeconds: 300, defaultBeautyLevel: 0 }) };
const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
const sessions = { listActive: jest.fn() };
const rooms = { findById: jest.fn() };
const provider = { kind: MediaProviderKind.ZEGO };

const make = () =>
  new VideoRoomMediaStateService(
    cache as never,
    sessions as never,
    rooms as never,
    provider as never,
    cfg as never,
  );

describe('VideoRoomMediaStateService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('getSnapshot returns the cached snapshot', async () => {
    cache.get.mockResolvedValue({ roomId: 'r', version: 2, participants: [] });
    expect((await make().getSnapshot('r'))!.version).toBe(2);
  });

  it('rebuild seeds participants from active sessions, version=1', async () => {
    rooms.findById.mockResolvedValue({ id: 'r', zegoRoomId: 'zego-1' });
    sessions.listActive.mockResolvedValue([
      {
        userId: 'u1',
        role: 'PUBLISHER',
        selfMutedAudio: false,
        selfMutedVideo: true,
        cameraFacing: 'FRONT',
      },
    ]);
    const snap = await make().rebuild('r');
    expect(snap.version).toBe(1);
    expect(snap.mediaRoomId).toBe('zego-1');
    expect(snap.provider).toBe(MediaProviderKind.ZEGO);
    expect(snap.participants[0].userId).toBe('u1');
    expect(snap.participants[0].role).toBe(ConnectionType.PUBLISHER);
    expect(cache.set).toHaveBeenCalled();
  });

  it('commit bumps the version and writes through', async () => {
    const base = {
      roomId: 'r',
      version: 5,
      updatedAt: '',
      mediaRoomId: 'z',
      provider: MediaProviderKind.ZEGO,
      participants: [],
    };
    const next = await make().commit('r', base as never, { participants: [] });
    expect(next.version).toBe(6);
    expect(cache.set).toHaveBeenCalledWith(
      'video-room:{r}:media',
      expect.objectContaining({ version: 6 }),
      300,
    );
  });
});
