import type { ConfigService } from '@nestjs/config';

/**
 * Typed, fully-coerced view of the `videoRoomChat` config namespace. Namespaced
 * config values surface as raw process.env strings at runtime, so every numeric
 * field is re-coerced here once, behind a single accessor, instead of scattering
 * `Number(...)` across the chat services (the VR-0 pattern).
 */
export interface VideoRoomChatConfig {
  messageMaxLength: number;
  maxMentions: number;
  maxPins: number;
  rateMax: number;
  rateWindowSeconds: number;
  dedupWindowSeconds: number;
  floodBurstMax: number;
  floodBurstWindowSeconds: number;
  /** Escalating cooldown ladder in seconds, indexed by violation count. */
  cooldownSteps: number[];
  recentBufferSize: number;
  recentBufferTtlSeconds: number;
  typingTtlSeconds: number;
  recallWindowSeconds: number;
  editWindowSeconds: number;
  receiptThrottleMs: number;
  systemMessageBroadcastOnlyAboveViewers: number;
  systemMessageSuppressAboveViewers: number;
}

type Raw = Record<keyof VideoRoomChatConfig, number | string>;

/** Parse "10,30,120" (or an already-parsed array) into a number ladder. */
function toLadder(value: number | string | number[]): number[] {
  if (Array.isArray(value)) return value.map(Number);
  return String(value)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
}

/** Read + coerce the `videoRoomChat` namespace into a typed config. */
export function loadVideoRoomChatConfig(config: ConfigService): VideoRoomChatConfig {
  const raw = config.get<Raw>('videoRoomChat');
  if (!raw) {
    throw new Error('videoRoomChat config namespace is not registered');
  }
  return {
    messageMaxLength: Number(raw.messageMaxLength),
    maxMentions: Number(raw.maxMentions),
    maxPins: Number(raw.maxPins),
    rateMax: Number(raw.rateMax),
    rateWindowSeconds: Number(raw.rateWindowSeconds),
    dedupWindowSeconds: Number(raw.dedupWindowSeconds),
    floodBurstMax: Number(raw.floodBurstMax),
    floodBurstWindowSeconds: Number(raw.floodBurstWindowSeconds),
    cooldownSteps: toLadder(raw.cooldownSteps as never),
    recentBufferSize: Number(raw.recentBufferSize),
    recentBufferTtlSeconds: Number(raw.recentBufferTtlSeconds),
    typingTtlSeconds: Number(raw.typingTtlSeconds),
    recallWindowSeconds: Number(raw.recallWindowSeconds),
    editWindowSeconds: Number(raw.editWindowSeconds),
    receiptThrottleMs: Number(raw.receiptThrottleMs),
    systemMessageBroadcastOnlyAboveViewers: Number(raw.systemMessageBroadcastOnlyAboveViewers),
    systemMessageSuppressAboveViewers: Number(raw.systemMessageSuppressAboveViewers),
  };
}
