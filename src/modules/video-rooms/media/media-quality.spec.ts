import { VideoQualityProfile } from '../enums';
import { PROFILE_BITRATE, selectQualityProfile, resolveBitrate } from './media-quality';

describe('media-quality', () => {
  it('has a spec for every concrete profile (not ADAPTIVE)', () => {
    for (const p of Object.values(VideoQualityProfile)) {
      if (p === VideoQualityProfile.ADAPTIVE) continue;
      expect(PROFILE_BITRATE[p].bitrateKbps).toBeGreaterThan(0);
    }
  });
  it('selects a high profile on a clean network', () => {
    expect(selectQualityProfile({ rttMs: 20, packetLossPct: 0 })).toBe(VideoQualityProfile.FULL_HD);
  });
  it('degrades under loss/latency', () => {
    expect(selectQualityProfile({ rttMs: 400, packetLossPct: 12 })).toBe(VideoQualityProfile.LOW);
    expect(selectQualityProfile({ rttMs: 150, packetLossPct: 3 })).toBe(VideoQualityProfile.HIGH);
  });
  it('never returns ADAPTIVE from the selector', () => {
    expect(selectQualityProfile({})).not.toBe(VideoQualityProfile.ADAPTIVE);
  });
  it('resolveBitrate clamps to the configured max', () => {
    expect(resolveBitrate(VideoQualityProfile.FULL_HD, 2500)).toBe(2500);
    expect(resolveBitrate(VideoQualityProfile.LOW, 2500)).toBe(PROFILE_BITRATE.LOW.bitrateKbps);
  });
});
