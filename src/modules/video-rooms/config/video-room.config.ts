import type { ConfigService } from '@nestjs/config';

/**
 * Typed, fully-coerced view of the `videoRoom` config namespace. Namespaced
 * config values surface as raw process.env strings at runtime (see the note in
 * config/configuration.ts), so every numeric field is re-coerced here once,
 * behind a single accessor, instead of scattering `Number(...)` across services.
 */
export interface VideoRoomConfig {
  defaultMaxParticipants: number;
  maxParticipantsCap: number;
  defaultMaxViewers: number;
  maxViewersCap: number;
  heartbeatIntervalSeconds: number;
  reconnectTimeoutSeconds: number;
  maxReconnectAttempts: number;
  idleTimeoutSeconds: number;
  cleanupIntervalSeconds: number;
  sessionTtlSeconds: number;
  stateTtlSeconds: number;
  cacheTtlSeconds: number;
  defaultQuality: string;
  maxBitrateKbps: number;
  maxRoomsPerOwner: number;
  mediaHeartbeatTtlSeconds: number;
  mediaMonitorIntervalSeconds: number;
  mediaReconnectGraceSeconds: number;
  mediaRecoveryTokenTtlSeconds: number;
  maxSubscriptionsPerUser: number;
  qualitySampleEvery: number;
  defaultBeautyLevel: number;
  viewerPresenceMode: 'durable' | 'ephemeral';
}

/** Raw shape as it comes off ConfigService (numbers may be strings at runtime). */
interface RawVideoRoomConfig {
  defaultMaxParticipants: number | string;
  maxParticipantsCap: number | string;
  defaultMaxViewers: number | string;
  maxViewersCap: number | string;
  heartbeatIntervalSeconds: number | string;
  reconnectTimeoutSeconds: number | string;
  maxReconnectAttempts: number | string;
  idleTimeoutSeconds: number | string;
  cleanupIntervalSeconds: number | string;
  sessionTtlSeconds: number | string;
  stateTtlSeconds: number | string;
  cacheTtlSeconds: number | string;
  defaultQuality: string;
  maxBitrateKbps: number | string;
  maxRoomsPerOwner: number | string;
  mediaHeartbeatTtlSeconds: number | string;
  mediaMonitorIntervalSeconds: number | string;
  mediaReconnectGraceSeconds: number | string;
  mediaRecoveryTokenTtlSeconds: number | string;
  maxSubscriptionsPerUser: number | string;
  qualitySampleEvery: number | string;
  defaultBeautyLevel: number | string;
  viewerPresenceMode: string;
}

/** Read + coerce the `videoRoom` namespace into a typed VideoRoomConfig. */
export function loadVideoRoomConfig(config: ConfigService): VideoRoomConfig {
  const raw = config.get<RawVideoRoomConfig>('videoRoom');
  if (!raw) {
    throw new Error('videoRoom config namespace is not registered');
  }
  return {
    defaultMaxParticipants: Number(raw.defaultMaxParticipants),
    maxParticipantsCap: Number(raw.maxParticipantsCap),
    defaultMaxViewers: Number(raw.defaultMaxViewers),
    maxViewersCap: Number(raw.maxViewersCap),
    heartbeatIntervalSeconds: Number(raw.heartbeatIntervalSeconds),
    reconnectTimeoutSeconds: Number(raw.reconnectTimeoutSeconds),
    maxReconnectAttempts: Number(raw.maxReconnectAttempts),
    idleTimeoutSeconds: Number(raw.idleTimeoutSeconds),
    cleanupIntervalSeconds: Number(raw.cleanupIntervalSeconds),
    sessionTtlSeconds: Number(raw.sessionTtlSeconds),
    stateTtlSeconds: Number(raw.stateTtlSeconds),
    cacheTtlSeconds: Number(raw.cacheTtlSeconds),
    defaultQuality: String(raw.defaultQuality),
    maxBitrateKbps: Number(raw.maxBitrateKbps),
    maxRoomsPerOwner: Number(raw.maxRoomsPerOwner),
    mediaHeartbeatTtlSeconds: Number(raw.mediaHeartbeatTtlSeconds),
    mediaMonitorIntervalSeconds: Number(raw.mediaMonitorIntervalSeconds),
    mediaReconnectGraceSeconds: Number(raw.mediaReconnectGraceSeconds),
    mediaRecoveryTokenTtlSeconds: Number(raw.mediaRecoveryTokenTtlSeconds),
    maxSubscriptionsPerUser: Number(raw.maxSubscriptionsPerUser),
    qualitySampleEvery: Number(raw.qualitySampleEvery),
    defaultBeautyLevel: Number(raw.defaultBeautyLevel),
    viewerPresenceMode: String(raw.viewerPresenceMode) as 'durable' | 'ephemeral',
  };
}
