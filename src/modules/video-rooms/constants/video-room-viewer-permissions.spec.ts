import { VIEWER_CAPABILITIES, videoRoomViewerCan } from './video-room-viewer-permissions';

describe('viewer capabilities', () => {
  it('grants read + social capabilities', () => {
    expect(videoRoomViewerCan('canReceiveStreams')).toBe(true);
    expect(videoRoomViewerCan('canRequestSeat')).toBe(true);
    expect(videoRoomViewerCan('canReportUser')).toBe(true);
  });
  it('denies publish/seat/manage capabilities', () => {
    expect(videoRoomViewerCan('canPublishCamera')).toBe(false);
    expect(videoRoomViewerCan('canOccupySeat')).toBe(false);
    expect(videoRoomViewerCan('canManageRoom')).toBe(false);
  });
  it('exposes the full matrix as a readonly record', () => {
    expect(Object.keys(VIEWER_CAPABILITIES)).toContain('canFollowHost');
  });
});
