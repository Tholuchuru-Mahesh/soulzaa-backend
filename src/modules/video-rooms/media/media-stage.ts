// media/media-stage.ts
import {
  AudioOutput,
  CameraFacing,
  ConnectionStatus,
  ConnectionType,
  MediaProviderKind,
  MediaStreamKind,
  MediaStreamState,
  VideoQualityProfile,
} from '../enums';
import type { BeautySettings } from './beauty-settings';

export interface MediaParticipant {
  userId: string;
  seatIndex: number | null;
  role: ConnectionType;
  connection: ConnectionStatus;
  streamId: string | null;
  streamKind: MediaStreamKind;
  streamState: MediaStreamState;
  camera: { on: boolean; facing: CameraFacing };
  mic: { on: boolean; selfMuted: boolean; adminMuted: boolean };
  audioOutput: AudioOutput;
  quality: VideoQualityProfile;
  beauty: BeautySettings;
  subscriptions: string[];
  joinedAt: string;
  lastHeartbeatAt: string;
}

export interface MediaStageSnapshot {
  roomId: string;
  version: number;
  updatedAt: string;
  mediaRoomId: string;
  provider: MediaProviderKind;
  participants: MediaParticipant[];
}

export type MediaStageMutation = Partial<Pick<MediaStageSnapshot, 'participants' | 'mediaRoomId'>>;
export type MediaStageView = MediaStageSnapshot;

export function toMediaStageView(s: MediaStageSnapshot): MediaStageView {
  return { ...s, participants: s.participants.map((p) => ({ ...p })) };
}

/** A fresh participant on join — audience default (SUBSCRIBER) unless seated. */
export function newParticipant(input: {
  userId: string;
  seatIndex: number | null;
  role: ConnectionType;
  nowIso: string;
  defaultBeauty: BeautySettings;
}): MediaParticipant {
  return {
    userId: input.userId,
    seatIndex: input.seatIndex,
    role: input.role,
    connection: ConnectionStatus.CONNECTING,
    streamId: null,
    streamKind: MediaStreamKind.CAMERA,
    streamState: MediaStreamState.CREATED,
    camera: { on: false, facing: CameraFacing.FRONT },
    mic: { on: false, selfMuted: false, adminMuted: false },
    audioOutput: AudioOutput.SPEAKER,
    quality: VideoQualityProfile.ADAPTIVE,
    beauty: { ...input.defaultBeauty },
    subscriptions: [],
    joinedAt: input.nowIso,
    lastHeartbeatAt: input.nowIso,
  };
}

/** Immutably patch the participant with `userId`; returns the same array reference if absent. */
export function upsertParticipant(
  list: MediaParticipant[],
  userId: string,
  patch: (p: MediaParticipant) => MediaParticipant,
): MediaParticipant[] {
  const idx = list.findIndex((p) => p.userId === userId);
  if (idx === -1) return list;
  const next = list.slice();
  next[idx] = patch(next[idx]);
  return next;
}
