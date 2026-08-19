import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { LiveStreamController } from './live-stream.controller';

const user = { id: 'u1' } as unknown as AuthenticatedUser;
const STREAM = 's1';
const META: RequestMetadata = {
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
  timestamp: '2026-08-19T00:00:00.000Z',
};

describe('LiveStreamController', () => {
  let service: any;
  let reports: any;
  let platformBans: any;
  let subject: LiveStreamController;

  beforeEach(() => {
    service = {
      moderateUser: jest.fn().mockResolvedValue(undefined),
    };
    reports = {};
    platformBans = { banUser: jest.fn().mockResolvedValue({ id: 'ban-1' }) };
    subject = new LiveStreamController(service, reports, platformBans);
  });

  describe('banGlobally — platform-wide 24h ban', () => {
    it('issues the ban with the actor, target, reason, and room context', async () => {
      const dto = { reason: 'harassment' } as never;
      await subject.banGlobally(user, STREAM, 't1', dto);

      expect(platformBans.banUser).toHaveBeenCalledWith({
        moderatorId: 'u1',
        targetUserId: 't1',
        reason: 'harassment',
        roomType: 'LIVE_STREAM',
        originRoomId: STREAM,
      });
    });
  });

  describe('moderateUser — WARN scope', () => {
    it('threads scope=ROOM through to the service', async () => {
      const dto = { targetUserId: 't1', action: 'WARN', reason: 'be nice', scope: 'ROOM' } as never;
      await subject.moderateUser(STREAM, user, dto, META);

      expect(service.moderateUser).toHaveBeenCalledWith(
        {
          streamId: STREAM,
          moderatorId: 'u1',
          targetUserId: 't1',
          action: 'WARN',
          reason: 'be nice',
          durationMinutes: undefined,
          scope: 'ROOM',
        },
        META,
      );
    });

    it('leaves scope undefined (private, the service default) when the caller omits it', async () => {
      const dto = { targetUserId: 't1', action: 'WARN', reason: 'be nice' } as never;
      await subject.moderateUser(STREAM, user, dto, META);

      expect(service.moderateUser).toHaveBeenCalledWith(
        expect.objectContaining({ scope: undefined }),
        META,
      );
    });
  });
});
