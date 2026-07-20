import { VideoRoomSeatStatus } from '@prisma/client';
import { DurableViewerPresence } from './durable-viewer-presence.service';

const seatSnapshot = (occupants: (string | null)[]) => ({
  roomId: 'r1',
  version: 1,
  updatedAt: '',
  hostSeatCount: occupants.length,
  guestSeatCount: 0,
  seats: occupants.map((occupantUserId, seatIndex) => ({
    seatIndex,
    occupantUserId,
    status: occupantUserId ? VideoRoomSeatStatus.OCCUPIED : VideoRoomSeatStatus.EMPTY,
  })),
});

describe('DurableViewerPresence', () => {
  let presence: any, seatState: any, repo: any, svc: DurableViewerPresence;
  beforeEach(() => {
    presence = {
      viewerCount: jest.fn().mockResolvedValue(10),
      addViewer: jest.fn(),
      removeViewer: jest.fn(),
      isViewer: jest.fn().mockResolvedValue(true),
    };
    seatState = {
      getSnapshot: jest.fn().mockResolvedValue(seatSnapshot(['a', null, 'b'])),
      rebuild: jest.fn(),
    };
    repo = {
      listActiveMembersExcluding: jest.fn().mockResolvedValue([{ userId: 'c' }]),
      countActiveMembersExcluding: jest.fn().mockResolvedValue(1),
    };
    svc = new DurableViewerPresence(presence, seatState, repo);
  });

  it('audienceCount = viewers − occupied seats', async () => {
    // 10 viewers − 2 occupied = 8
    await expect(svc.audienceCount('r1')).resolves.toBe(8);
  });

  it('audienceCount clamps to 0 when occupied seats exceed the viewer count', async () => {
    presence.viewerCount.mockResolvedValue(1);
    seatState.getSnapshot.mockResolvedValue(seatSnapshot(['a', 'b', 'c']));
    await expect(svc.audienceCount('r1')).resolves.toBe(0);
  });

  it('listAudience pushes the seated-id exclusion into the repo query and returns its page', async () => {
    // seated = {a, b} (from the seat snapshot)
    const page = await svc.listAudience('r1', 20, 0);

    const excludeArgs = repo.listActiveMembersExcluding.mock.calls[0];
    expect(excludeArgs[0]).toBe('r1');
    expect([...excludeArgs[1]].sort()).toEqual(['a', 'b']);
    expect(excludeArgs[2]).toBe(20);
    expect(excludeArgs[3]).toBe(0);

    const countArgs = repo.countActiveMembersExcluding.mock.calls[0];
    expect(countArgs[0]).toBe('r1');
    expect([...countArgs[1]].sort()).toEqual(['a', 'b']);

    expect(page).toEqual({ items: [{ userId: 'c' }], total: 1 });
  });

  it('markPresent/markAbsent delegate to the presence set', async () => {
    await svc.markPresent('r1', 'u1');
    expect(presence.addViewer).toHaveBeenCalledWith('r1', 'u1');
    await svc.markAbsent('r1', 'u1');
    expect(presence.removeViewer).toHaveBeenCalledWith('r1', 'u1');
  });

  it('isPresent delegates to presence.isViewer and returns its result', async () => {
    presence.isViewer.mockResolvedValue(true);
    await expect(svc.isPresent('r1', 'u1')).resolves.toBe(true);
    expect(presence.isViewer).toHaveBeenCalledWith('r1', 'u1');
  });
});
