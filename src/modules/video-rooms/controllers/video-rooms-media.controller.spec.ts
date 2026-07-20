import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { VideoRoomsMediaController } from './video-rooms-media.controller';

const user = { id: 'u1', roles: [] } as unknown as AuthenticatedUser;
const ACTOR = { id: 'u1', roles: [] };
const IP = '1.2.3.4';
const ROOM = '11111111-1111-1111-1111-111111111111';

describe('VideoRoomsMediaController', () => {
  let media: any;
  let recovery: any;
  let ctrl: VideoRoomsMediaController;

  beforeEach(() => {
    media = {
      joinMedia: jest.fn().mockResolvedValue({ mediaSession: {}, stage: {} }),
      leaveMedia: jest.fn(),
      refreshToken: jest.fn(),
      startPublish: jest.fn(),
      stopPublish: jest.fn(),
      pausePublish: jest.fn(),
      resumePublish: jest.fn(),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      cameraOn: jest.fn(),
      cameraOff: jest.fn(),
      switchCamera: jest.fn(),
      micOn: jest.fn(),
      micOff: jest.fn(),
      forceMute: jest.fn(),
      setAudioOutput: jest.fn(),
      setQuality: jest.fn(),
      setBeauty: jest.fn(),
      heartbeat: jest.fn(),
      getMediaState: jest.fn(),
    };
    recovery = { recover: jest.fn() };
    ctrl = new VideoRoomsMediaController(media, recovery);
  });

  it('join delegates with the actor + ip', async () => {
    await ctrl.join(ROOM, user, {} as never, IP);
    expect(media.joinMedia).toHaveBeenCalledWith(ACTOR, ROOM, {}, IP);
  });

  it('leave delegates with the actor + ip', async () => {
    await ctrl.leave(ROOM, user, IP);
    expect(media.leaveMedia).toHaveBeenCalledWith(ACTOR, ROOM, IP);
  });

  it('refresh delegates with the actor', async () => {
    await ctrl.refresh(ROOM, user);
    expect(media.refreshToken).toHaveBeenCalledWith(ACTOR, ROOM);
  });

  it('publish delegates with the actor + dto + ip', async () => {
    const dto = { streamKind: 'CAMERA' } as never;
    await ctrl.publish(ROOM, user, dto, IP);
    expect(media.startPublish).toHaveBeenCalledWith(ACTOR, ROOM, dto, IP);
  });

  it('stop delegates with the actor + ip', async () => {
    await ctrl.stop(ROOM, user, IP);
    expect(media.stopPublish).toHaveBeenCalledWith(ACTOR, ROOM, IP);
  });

  it('pause delegates with the actor', async () => {
    await ctrl.pause(ROOM, user);
    expect(media.pausePublish).toHaveBeenCalledWith(ACTOR, ROOM);
  });

  it('resume delegates with the actor', async () => {
    await ctrl.resume(ROOM, user);
    expect(media.resumePublish).toHaveBeenCalledWith(ACTOR, ROOM);
  });

  it('subscribe delegates with the actor + dto + ip', async () => {
    const dto = { targetUserId: 't1', priority: 1 } as never;
    await ctrl.subscribe(ROOM, user, dto, IP);
    expect(media.subscribe).toHaveBeenCalledWith(ACTOR, ROOM, dto, IP);
  });

  it('unsubscribe delegates with the actor + dto + ip', async () => {
    const dto = { targetUserId: 't1' } as never;
    await ctrl.unsubscribe(ROOM, user, dto, IP);
    expect(media.unsubscribe).toHaveBeenCalledWith(ACTOR, ROOM, dto, IP);
  });

  it('cameraOn delegates', async () => {
    await ctrl.cameraOn(ROOM, user, IP);
    expect(media.cameraOn).toHaveBeenCalledWith(ACTOR, ROOM, IP);
  });

  it('cameraOff delegates', async () => {
    await ctrl.cameraOff(ROOM, user, IP);
    expect(media.cameraOff).toHaveBeenCalledWith(ACTOR, ROOM, IP);
  });

  it('switchCamera delegates with the actor + dto + ip', async () => {
    const dto = { facing: 'FRONT' } as never;
    await ctrl.switchCamera(ROOM, user, dto, IP);
    expect(media.switchCamera).toHaveBeenCalledWith(ACTOR, ROOM, dto, IP);
  });

  it('micOn delegates', async () => {
    await ctrl.micOn(ROOM, user, IP);
    expect(media.micOn).toHaveBeenCalledWith(ACTOR, ROOM, IP);
  });

  it('micOff delegates', async () => {
    await ctrl.micOff(ROOM, user, IP);
    expect(media.micOff).toHaveBeenCalledWith(ACTOR, ROOM, IP);
  });

  it('forceMute delegates with the actor + dto + ip', async () => {
    const dto = { targetUserId: 't1', muted: true } as never;
    await ctrl.forceMute(ROOM, user, dto, IP);
    expect(media.forceMute).toHaveBeenCalledWith(ACTOR, ROOM, dto, IP);
  });

  it('audioOutput delegates with the actor + dto', async () => {
    const dto = { output: 'SPEAKER' } as never;
    await ctrl.audioOutput(ROOM, user, dto);
    expect(media.setAudioOutput).toHaveBeenCalledWith(ACTOR, ROOM, dto);
  });

  it('quality delegates with the actor + dto', async () => {
    const dto = { profile: 'HIGH' } as never;
    await ctrl.quality(ROOM, user, dto);
    expect(media.setQuality).toHaveBeenCalledWith(ACTOR, ROOM, dto);
  });

  it('beauty delegates with the actor + dto', async () => {
    const dto = { enabled: true, level: 50 } as never;
    await ctrl.beauty(ROOM, user, dto);
    expect(media.setBeauty).toHaveBeenCalledWith(ACTOR, ROOM, dto);
  });

  it('heartbeat delegates with the actor + dto', async () => {
    const dto = { rttMs: 40 } as never;
    await ctrl.heartbeat(ROOM, user, dto);
    expect(media.heartbeat).toHaveBeenCalledWith(ACTOR, ROOM, dto);
  });

  it('recover delegates to the recovery service with the actor + dto', async () => {
    const dto = { lastVersion: 3 } as never;
    await ctrl.recover(ROOM, user, dto);
    expect(recovery.recover).toHaveBeenCalledWith(ACTOR, ROOM, dto);
  });

  it('state delegates with the actor', async () => {
    await ctrl.state(ROOM, user);
    expect(media.getMediaState).toHaveBeenCalledWith(ACTOR, ROOM);
  });
});
