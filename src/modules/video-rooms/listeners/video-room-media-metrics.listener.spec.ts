import { VIDEO_ROOM_MEDIA_EVENTS } from '../events/video-room-media.events';
import { VideoRoomMediaMetricsListener } from './video-room-media-metrics.listener';

describe('VideoRoomMediaMetricsListener', () => {
  let handlers: Record<string, (e: { payload: unknown }) => void>;
  let metrics: Record<string, jest.Mock>;

  beforeEach(() => {
    handlers = {};
    const bus = {
      subscribe: (name: string, handler: (e: { payload: unknown }) => void) => {
        handlers[name] = handler;
        return () => {};
      },
    };
    metrics = {
      incMediaSession: jest.fn(),
      incPublish: jest.fn(),
      incActiveStream: jest.fn(),
      decActiveStream: jest.fn(),
      incMediaFailure: jest.fn(),
      incRecoverySuccess: jest.fn(),
      incCameraToggle: jest.fn(),
      incMicToggle: jest.fn(),
      incBeautyChange: jest.fn(),
      incBitrateChange: jest.fn(),
    };
    new VideoRoomMediaMetricsListener(bus as never, metrics as never).onModuleInit();
  });

  it('counts publishes + active streams on STREAM_PUBLISHED', () => {
    handlers[VIDEO_ROOM_MEDIA_EVENTS.STREAM_PUBLISHED]({ payload: {} });
    expect(metrics.incPublish).toHaveBeenCalled();
    expect(metrics.incActiveStream).toHaveBeenCalled();
  });

  it('counts media sessions on SESSION_CREATED', () => {
    handlers[VIDEO_ROOM_MEDIA_EVENTS.SESSION_CREATED]({ payload: {} });
    expect(metrics.incMediaSession).toHaveBeenCalledTimes(1);
  });

  it('decrements active streams on STREAM_STOPPED', () => {
    handlers[VIDEO_ROOM_MEDIA_EVENTS.STREAM_STOPPED]({ payload: {} });
    expect(metrics.decActiveStream).toHaveBeenCalledTimes(1);
  });

  it('counts failures and recoveries', () => {
    handlers[VIDEO_ROOM_MEDIA_EVENTS.MEDIA_FAILED]({ payload: {} });
    handlers[VIDEO_ROOM_MEDIA_EVENTS.MEDIA_RECOVERED]({ payload: {} });
    expect(metrics.incMediaFailure).toHaveBeenCalledTimes(1);
    expect(metrics.incRecoverySuccess).toHaveBeenCalledTimes(1);
  });

  it('counts camera toggles on both enable and disable', () => {
    handlers[VIDEO_ROOM_MEDIA_EVENTS.CAMERA_ENABLED]({ payload: {} });
    handlers[VIDEO_ROOM_MEDIA_EVENTS.CAMERA_DISABLED]({ payload: {} });
    expect(metrics.incCameraToggle).toHaveBeenCalledTimes(2);
  });

  it('counts mic toggles on both enable and disable', () => {
    handlers[VIDEO_ROOM_MEDIA_EVENTS.MIC_ENABLED]({ payload: {} });
    handlers[VIDEO_ROOM_MEDIA_EVENTS.MIC_DISABLED]({ payload: {} });
    expect(metrics.incMicToggle).toHaveBeenCalledTimes(2);
  });

  it('counts beauty changes', () => {
    handlers[VIDEO_ROOM_MEDIA_EVENTS.BEAUTY_CHANGED]({ payload: {} });
    expect(metrics.incBeautyChange).toHaveBeenCalledTimes(1);
  });

  it('counts bitrate changes on QUALITY_CHANGED', () => {
    handlers[VIDEO_ROOM_MEDIA_EVENTS.QUALITY_CHANGED]({ payload: {} });
    expect(metrics.incBitrateChange).toHaveBeenCalledTimes(1);
  });
});
