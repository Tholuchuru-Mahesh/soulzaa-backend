import { VideoRoomNotificationMuteService } from './video-room-notification-mute.service';

function makeDeps() {
  const store = new Set<string>();
  const repo = {
    create: jest.fn(async (u: string, r: string) => {
      store.add(`${u}:${r}`);
    }),
    remove: jest.fn(async (u: string, r: string) => {
      store.delete(`${u}:${r}`);
    }),
    list: jest.fn(async (u: string) =>
      [...store].filter((k) => k.startsWith(`${u}:`)).map((k) => k.split(':')[1]),
    ),
    exists: jest.fn(async (u: string, r: string) => store.has(`${u}:${r}`)),
  };
  const client = { sismember: jest.fn(), sadd: jest.fn(), srem: jest.fn() };
  const redis = { client };
  return { repo, redis, client };
}

describe('VideoRoomNotificationMuteService', () => {
  it('isMuted reads the Redis cache first, falling back to the repo on a miss', async () => {
    const d = makeDeps();
    d.client.sismember.mockResolvedValue(1);
    const svc = new VideoRoomNotificationMuteService(d.repo as never, d.redis as never);
    expect(await svc.isMuted('u1', 'r1')).toBe(true);
    expect(d.client.sismember).toHaveBeenCalled();
    expect(d.repo.exists).not.toHaveBeenCalled();
  });

  it('mute persists to the repo and adds to the Redis set', async () => {
    const d = makeDeps();
    const svc = new VideoRoomNotificationMuteService(d.repo as never, d.redis as never);
    await svc.mute('u1', 'r1');
    expect(d.repo.create).toHaveBeenCalledWith('u1', 'r1');
    expect(d.client.sadd).toHaveBeenCalledWith('video-room:notif:mute:u1', 'r1');
  });

  it('isMuted falls back to the repo on a cache miss and warms the cache when persisted', async () => {
    const d = makeDeps();
    d.client.sismember.mockResolvedValue(0);
    d.repo.exists.mockResolvedValue(true);
    const svc = new VideoRoomNotificationMuteService(d.repo as never, d.redis as never);
    expect(await svc.isMuted('u1', 'r1')).toBe(true);
    expect(d.client.sismember).toHaveBeenCalledWith('video-room:notif:mute:u1', 'r1');
    expect(d.repo.exists).toHaveBeenCalledWith('u1', 'r1');
    expect(d.client.sadd).toHaveBeenCalledWith('video-room:notif:mute:u1', 'r1');
  });

  it('isMuted returns false on a cache miss when not persisted, without warming the cache', async () => {
    const d = makeDeps();
    d.client.sismember.mockResolvedValue(0);
    d.repo.exists.mockResolvedValue(false);
    const svc = new VideoRoomNotificationMuteService(d.repo as never, d.redis as never);
    expect(await svc.isMuted('u1', 'r1')).toBe(false);
    expect(d.repo.exists).toHaveBeenCalledWith('u1', 'r1');
    expect(d.client.sadd).not.toHaveBeenCalled();
  });

  it('unmute removes from the repo and the Redis set', async () => {
    const d = makeDeps();
    const svc = new VideoRoomNotificationMuteService(d.repo as never, d.redis as never);
    await svc.unmute('u1', 'r1');
    expect(d.repo.remove).toHaveBeenCalledWith('u1', 'r1');
    expect(d.client.srem).toHaveBeenCalledWith('video-room:notif:mute:u1', 'r1');
  });
});
