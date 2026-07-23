// src/modules/video-rooms/services/video-room-notification-fanout.service.spec.ts
import { VideoRoomNotificationFanoutService } from './video-room-notification-fanout.service';
import { VIDEO_ROOM_NOTIFICATION_KINDS as K } from '../constants/video-room-notification.constants';

function makeDeps(chunk = 100) {
  const registry = { register: jest.fn() };
  const queue = { enqueue: jest.fn().mockResolvedValue({ id: 'j' }) };
  const social = { pageFollowerIds: jest.fn(), followerIds: jest.fn() };
  const added = new Set<string>();
  const client = {
    sadd: jest.fn(async (_k: string, m: string) => (added.has(m) ? 0 : (added.add(m), 1))),
    expire: jest.fn(),
  };
  const redis = { client };
  const dispatcher = { deliverOne: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue(chunk) };
  const rooms = { pageActiveMemberIds: jest.fn() };
  const metrics = { incFanoutRecipients: jest.fn(), observeFanoutBatch: jest.fn() };
  return { registry, queue, social, redis, dispatcher, config, client, rooms, metrics };
}

const job = (cursor: number) => ({
  kind: K.ROOM_STARTED,
  source: 'FOLLOWERS',
  roomId: 'r1',
  ownerId: 'o1',
  occurrenceId: 'occ1',
  cursor,
  title: 'Live',
  body: 'o1 is live',
});

describe('VideoRoomNotificationFanoutService', () => {
  it('delivers one chunk, dedupes via SADD, and enqueues the next cursor when more remain', async () => {
    const d = makeDeps(100); // in-bounds chunk (validated floor is 100)
    const chunkIds = Array.from({ length: 100 }, (_, i) => `u${i}`);
    d.social.pageFollowerIds.mockResolvedValue({ ids: chunkIds, total: 150 });
    const svc = new VideoRoomNotificationFanoutService(
      d.registry as never,
      d.queue as never,
      d.social as never,
      d.redis as never,
      d.dispatcher as never,
      d.config as never,
      d.rooms as never,
      d.metrics as never,
    );

    await svc.handle(job(0) as never);

    expect(d.dispatcher.deliverOne).toHaveBeenCalledTimes(100);
    expect(d.queue.enqueue).toHaveBeenCalledWith(
      'notifications',
      expect.any(String),
      expect.objectContaining({ cursor: 100 }),
      expect.objectContaining({ jobId: 'vrnotif:occ1:100' }),
    );
    expect(d.metrics.incFanoutRecipients).toHaveBeenCalledWith(100);
    expect(d.metrics.observeFanoutBatch).toHaveBeenCalled();
  });

  it('a replayed chunk sends each recipient at most once (SADD returns 0)', async () => {
    const d = makeDeps();
    d.social.pageFollowerIds.mockResolvedValue({ ids: ['a', 'b'], total: 2 });
    const svc = new VideoRoomNotificationFanoutService(
      d.registry as never,
      d.queue as never,
      d.social as never,
      d.redis as never,
      d.dispatcher as never,
      d.config as never,
      d.rooms as never,
      d.metrics as never,
    );

    await svc.handle(job(0) as never);
    await svc.handle(job(0) as never); // replay

    expect(d.dispatcher.deliverOne).toHaveBeenCalledTimes(2); // not 4
    expect(d.queue.enqueue).not.toHaveBeenCalled(); // total exhausted
  });

  it('MEMBERS source pages room members instead of followers', async () => {
    const d = makeDeps();
    d.rooms.pageActiveMemberIds.mockResolvedValue({ ids: ['m1', 'm2'], total: 2 });
    const svc = new VideoRoomNotificationFanoutService(
      d.registry as never,
      d.queue as never,
      d.social as never,
      d.redis as never,
      d.dispatcher as never,
      d.config as never,
      d.rooms as never,
      d.metrics as never,
    );
    await svc.handle({
      kind: K.ANNOUNCEMENT,
      source: 'MEMBERS',
      roomId: 'r1',
      ownerId: '',
      occurrenceId: 'occM',
      cursor: 0,
      title: 'a',
      body: 'b',
    } as never);
    expect(d.rooms.pageActiveMemberIds).toHaveBeenCalledWith('r1', 0, expect.any(Number));
    expect(d.social.pageFollowerIds).not.toHaveBeenCalled();
    expect(d.dispatcher.deliverOne).toHaveBeenCalledTimes(2);
  });
});
