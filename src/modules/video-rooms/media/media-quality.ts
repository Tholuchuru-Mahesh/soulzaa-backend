import { VideoQualityProfile } from '../enums';

export interface QualitySpec {
  bitrateKbps: number;
  width: number;
  height: number;
  fps: number;
}
export interface NetworkSample {
  rttMs?: number;
  packetLossPct?: number;
  bitrateKbps?: number;
}

type ConcreteProfile = Exclude<VideoQualityProfile, VideoQualityProfile.ADAPTIVE>;

/** Bitrate/resolution/fps per concrete profile. Bitrates are ceilings, clamped by config maxBitrateKbps. */
export const PROFILE_BITRATE: Record<ConcreteProfile, QualitySpec> = {
  [VideoQualityProfile.LOW]: { bitrateKbps: 300, width: 320, height: 240, fps: 15 },
  [VideoQualityProfile.MEDIUM]: { bitrateKbps: 600, width: 640, height: 360, fps: 20 },
  [VideoQualityProfile.HIGH]: { bitrateKbps: 1000, width: 848, height: 480, fps: 24 },
  [VideoQualityProfile.HD]: { bitrateKbps: 1800, width: 1280, height: 720, fps: 30 },
  [VideoQualityProfile.FULL_HD]: { bitrateKbps: 3000, width: 1920, height: 1080, fps: 30 },
};

/**
 * Adaptive quality selector (VR-5). Maps a live network sample to a concrete
 * profile. Higher RTT / packet loss ⇒ a lower tier. Missing fields are treated
 * as pristine (favor quality) — the caller only invokes this when ADAPTIVE is on.
 */
export function selectQualityProfile(sample: NetworkSample): ConcreteProfile {
  const rtt = sample.rttMs ?? 0;
  const loss = sample.packetLossPct ?? 0;
  if (loss >= 10 || rtt >= 350) return VideoQualityProfile.LOW;
  if (loss >= 5 || rtt >= 250) return VideoQualityProfile.MEDIUM;
  if (loss >= 2 || rtt >= 120) return VideoQualityProfile.HIGH;
  if (loss >= 0.5 || rtt >= 60) return VideoQualityProfile.HD;
  return VideoQualityProfile.FULL_HD;
}

/** The effective bitrate for a profile, clamped to the room's configured ceiling. */
export function resolveBitrate(profile: VideoQualityProfile, maxBitrateKbps: number): number {
  const concrete = profile === VideoQualityProfile.ADAPTIVE ? VideoQualityProfile.HD : profile;
  return Math.min(PROFILE_BITRATE[concrete as ConcreteProfile].bitrateKbps, maxBitrateKbps);
}
