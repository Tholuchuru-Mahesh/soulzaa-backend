import { ConfigService } from '@nestjs/config';
import { ShareService } from './share.service';

/**
 * The link SHAPES are the contract here.
 *
 * A share link is pasted into a chat and opened days later by someone who was
 * never in the room, so the exact path matters more than almost anything else
 * in this service: `room/:id` and `video-room/:id` resolve to two different
 * client screens, and getting them crossed hands the recipient a link that
 * opens the wrong surface — or nothing at all.
 */
describe('ShareService', () => {
  const users = { findByUsername: jest.fn() };

  function build(): ShareService {
    const config = {
      get: () => ({
        shareBaseUrl: 'https://soulzaa.test/',
        deeplinkScheme: 'soulzaa://',
      }),
    } as unknown as ConfigService;
    return new ShareService(users as never, config);
  }

  beforeEach(() => jest.clearAllMocks());

  it('roomShare builds the audio-room link shape', () => {
    expect(build().roomShare('r1')).toEqual({
      resourceType: 'room',
      resourceId: 'r1',
      shareUrl: 'https://soulzaa.test/r/r1',
      deepLink: 'soulzaa://room/r1',
      payload: 'soulzaa://room/r1',
    });
  });

  it('videoRoomShare builds the VIDEO-room link shape', () => {
    expect(build().videoRoomShare('v1')).toEqual({
      resourceType: 'video-room',
      resourceId: 'v1',
      shareUrl: 'https://soulzaa.test/vr/v1',
      deepLink: 'soulzaa://video-room/v1',
      payload: 'soulzaa://video-room/v1',
    });
  });

  // The whole reason the video-room route exists: `roomShare` would format a
  // video room's id into `room/:id`, which the app resolves to the AUDIO room
  // screen. The two must never collapse into one link.
  it('a video room never gets the audio-room link', () => {
    const svc = build();
    expect(svc.videoRoomShare('same-id').deepLink).not.toEqual(
      svc.roomShare('same-id').deepLink,
    );
    expect(svc.videoRoomShare('same-id').shareUrl).not.toEqual(
      svc.roomShare('same-id').shareUrl,
    );
  });

  it('QR content is the share content, for both room kinds', () => {
    const svc = build();
    expect(svc.roomQr('r1')).toEqual(svc.roomShare('r1'));
    expect(svc.videoRoomQr('v1')).toEqual(svc.videoRoomShare('v1'));
  });

  // A configured base with a trailing slash must not produce `//r/id`.
  it('a trailing slash on the share base is normalised away', () => {
    expect(build().videoRoomShare('v1').shareUrl).toBe(
      'https://soulzaa.test/vr/v1',
    );
  });

  it('userQr rejects an unknown username', async () => {
    users.findByUsername.mockResolvedValue(null);
    await expect(build().userQr('nobody')).rejects.toThrow(/not found/i);
  });

  it('userQr resolves the id from the user record, not from the handle', async () => {
    users.findByUsername.mockResolvedValue({ id: 'u-42' });
    await expect(build().userQr('ada')).resolves.toEqual({
      resourceType: 'user',
      resourceId: 'u-42',
      shareUrl: 'https://soulzaa.test/u/ada',
      deepLink: 'soulzaa://user/ada',
      payload: 'soulzaa://user/ada',
    });
  });
});
