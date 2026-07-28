import { registerAs } from '@nestjs/config';
import { validateEnv, type Env } from './env.validation';

/**
 * Typed, namespaced config. Consume via `ConfigService`, e.g.
 *   configService.get('jwt', { infer: true }).accessSecret
 * or inject a namespace with `@Inject(jwtConfig.KEY)`.
 *
 * Keeping namespaces small keeps module boundaries clean.
 */

let coerced: Env | undefined;

/**
 * The validated **and coerced** environment.
 *
 * This used to be `process.env as unknown as Env`, which was a lie: `process.env`
 * only ever holds strings. Nest runs `validateEnv` and keeps the coerced result for
 * `ConfigService.get('SOME_VAR')`, but it does not write it back — anything it does
 * copy into `process.env` gets stringified again on the way in. So every `number` in
 * the `Env` type was a string at runtime, and every `boolean` was the string
 * `"false"` (which is truthy).
 *
 * That went unnoticed because JavaScript hid it: `'4000' > 10` coerces, `'900' * 1000`
 * coerces, and a truthy `"false"` and a `true` behave alike. It stopped hiding the
 * moment a value reached something that actually checks — Prisma's `take`, which
 * rejects a string with `Expected Int`.
 *
 * Parsing is lazy because `.env` is only merged into `process.env` by
 * `ConfigModule.forRoot`, which runs *after* this module is imported. Every
 * `registerAs` factory below runs later still, during module init, by which point the
 * environment is fully populated.
 */
const env = (): Env => (coerced ??= validateEnv(process.env));

export const appConfig = registerAs('app', () => ({
  nodeEnv: env().NODE_ENV,
  port: env().PORT,
  apiPrefix: env().API_PREFIX,
  corsOrigins:
    env().CORS_ORIGINS === '*'
      ? '*'
      : env()
          .CORS_ORIGINS.split(',')
          .map((s) => s.trim()),
  logLevel: env().LOG_LEVEL,
  metricsEnabled: env().METRICS_ENABLED,
}));

export const monitoringConfig = registerAs('monitoring', () => ({
  slowQueryWarnMs: env().SLOW_QUERY_WARN_MS,
  slowQueryErrorMs: env().SLOW_QUERY_ERROR_MS,
  slowRedisMs: env().SLOW_REDIS_MS,
  slowRequestMs: env().SLOW_REQUEST_MS,
  livenessMaxEventLoopLagMs: env().LIVENESS_MAX_EVENT_LOOP_LAG_MS,
}));

/**
 * Distributed tracing (OpenTelemetry). The SDK itself is started by the
 * pre-Nest bootstrap in `main.ts` (which reads these same env vars directly);
 * this namespace mirrors them for readiness/health reporting.
 */
export const tracingConfig = registerAs('tracing', () => ({
  enabled: env().OTEL_ENABLED,
  endpoint: env().OTEL_EXPORTER_OTLP_ENDPOINT,
  serviceName: env().OTEL_SERVICE_NAME,
  serviceVersion: env().OTEL_SERVICE_VERSION,
  sampleRatio: env().OTEL_TRACES_SAMPLER_RATIO,
}));

/**
 * Append Prisma connection-pool params to a base connection string without
 * clobbering params already present (e.g. `schema=public`, `pgbouncer=true`).
 * Pure function so `PrismaService` can build its runtime `datasourceUrl`.
 */
export function buildPooledUrl(
  base: string,
  opts: { connectionLimit?: number; poolTimeout: number; connectTimeout: number },
): string {
  const url = new URL(base);
  if (opts.connectionLimit !== undefined) {
    url.searchParams.set('connection_limit', String(opts.connectionLimit));
  }
  url.searchParams.set('pool_timeout', String(opts.poolTimeout));
  url.searchParams.set('connect_timeout', String(opts.connectTimeout));
  return url.toString();
}

export const databaseConfig = registerAs('database', () => ({
  url: env().DATABASE_URL,
  // Direct connection for migrations; falls back to the pooled URL when unset.
  directUrl: env().DIRECT_URL ?? env().DATABASE_URL,
  connectionLimit: env().DATABASE_CONNECTION_LIMIT,
  poolTimeout: env().DATABASE_POOL_TIMEOUT,
  connectTimeout: env().DATABASE_CONNECT_TIMEOUT,
}));

/** Parse `host:port,host:port` into ioredis ClusterNode objects. Empty = standalone. */
function parseClusterNodes(raw?: string): { host: string; port: number }[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => {
      const [host, port] = entry.trim().split(':');
      return { host, port: Number(port) || 6379 };
    })
    .filter((node) => node.host.length > 0);
}

export const redisConfig = registerAs('redis', () => ({
  url: env().REDIS_URL,
  clusterNodes: parseClusterNodes(env().REDIS_CLUSTER_NODES),
}));

export const jwtConfig = registerAs('jwt', () => ({
  accessSecret: env().JWT_ACCESS_SECRET,
  accessTtl: env().JWT_ACCESS_TTL,
  refreshSecret: env().JWT_REFRESH_SECRET,
  refreshTtl: env().JWT_REFRESH_TTL,
}));

export const authConfig = registerAs('auth', () => ({
  bcryptSaltRounds: env().BCRYPT_SALT_ROUNDS,
}));

/** Parse a comma-separated env list into a trimmed, non-empty string[]. */
function parseCsv(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const otpConfig = registerAs('otp', () => ({
  length: env().OTP_LENGTH,
  ttlSeconds: env().OTP_TTL_SECONDS,
  maxAttempts: env().OTP_MAX_ATTEMPTS,
  maxResends: env().OTP_MAX_RESENDS,
  resendCooldownSeconds: env().OTP_RESEND_COOLDOWN_SECONDS,
  blockSeconds: env().OTP_BLOCK_SECONDS,
  cleanupCron: env().OTP_CLEANUP_CRON,
  retentionHours: env().OTP_RETENTION_HOURS,
  smsProvider: env().OTP_SMS_PROVIDER,
  emailProvider: env().OTP_EMAIL_PROVIDER,
}));

export const otpProvidersConfig = registerAs('otpProviders', () => ({
  twilio: {
    accountSid: env().TWILIO_ACCOUNT_SID,
    authToken: env().TWILIO_AUTH_TOKEN,
    fromNumber: env().TWILIO_FROM_NUMBER,
  },
  msg91: {
    authKey: env().MSG91_AUTH_KEY,
    senderId: env().MSG91_SENDER_ID,
  },
  // AWS SNS reuses the storage/AWS credentials (region + access keys).
  awsSns: {
    region: env().AWS_REGION,
    accessKeyId: env().AWS_ACCESS_KEY_ID,
    secretAccessKey: env().AWS_SECRET_ACCESS_KEY,
  },
}));

export const securityConfig = registerAs('security', () => ({
  loginMaxAttempts: env().LOGIN_MAX_ATTEMPTS,
  loginLockSeconds: env().LOGIN_LOCK_SECONDS,
  passwordResetTtlSeconds: env().PASSWORD_RESET_TTL_SECONDS,
  minUserAge: env().MIN_USER_AGE,
}));

export const profileConfig = registerAs('profile', () => ({
  mediaPublicBaseUrl: env().MEDIA_PUBLIC_BASE_URL,
  shareBaseUrl: env().SHARE_BASE_URL,
  deeplinkScheme: env().APP_DEEPLINK_SCHEME,
  cacheTtlSeconds: env().PROFILE_CACHE_TTL_SECONDS,
}));

export const pushConfig = registerAs('push', () => ({
  provider: env().PUSH_PROVIDER,
  suspiciousLoginAlerts: env().SUSPICIOUS_LOGIN_ALERTS,
}));

export const pushProvidersConfig = registerAs('pushProviders', () => ({
  fcm: {
    projectId: env().FCM_PROJECT_ID,
    clientEmail: env().FCM_CLIENT_EMAIL,
    privateKey: env().FCM_PRIVATE_KEY,
  },
  apns: {
    keyId: env().APNS_KEY_ID,
    teamId: env().APNS_TEAM_ID,
    bundleId: env().APNS_BUNDLE_ID,
    privateKey: env().APNS_PRIVATE_KEY,
  },
}));

export const paymentsConfig = registerAs('payments', () => ({
  googlePlayLicenseKey: env().GOOGLE_PLAY_LICENSE_KEY,
  appleSharedSecret: env().APPLE_IAP_SHARED_SECRET,
  appleUseSandbox: env().APPLE_IAP_USE_SANDBOX,
  razorpayKeySecret: env().RAZORPAY_KEY_SECRET,
  stripeWebhookSecret: env().STRIPE_WEBHOOK_SECRET,
  allowMockGateway: env().PAYMENTS_ALLOW_MOCK_GATEWAY,
}));

export const authorizationConfig = registerAs('authorization', () => ({
  cacheTtlSeconds: env().AUTHORIZATION_CACHE_TTL_SECONDS,
  scopeCountryBridge: env().AUTHORIZATION_SCOPE_COUNTRY_BRIDGE,
}));

export const privacyConfig = registerAs('privacy', () => ({
  cacheTtlSeconds: env().PRIVACY_CACHE_TTL_SECONDS,
  defaultVisibility: env().PRIVACY_DEFAULT_VISIBILITY,
}));

export const sessionConfig = registerAs('session', () => ({
  maxConcurrent: env().SESSION_MAX_CONCURRENT,
  inactivitySeconds: env().SESSION_INACTIVITY_SECONDS,
  absoluteTtlSeconds: env().SESSION_ABSOLUTE_TTL_SECONDS,
  hijackStrictIp: env().SESSION_HIJACK_STRICT_IP,
}));

export const socialConfig = registerAs('social', () => ({
  googleClientIds: parseCsv(env().GOOGLE_CLIENT_IDS),
  appleClientIds: parseCsv(env().APPLE_CLIENT_IDS),
  appleIssuer: env().APPLE_ISSUER,
}));

export const storageConfig = registerAs('storage', () => ({
  region: env().AWS_REGION,
  accessKeyId: env().AWS_ACCESS_KEY_ID,
  secretAccessKey: env().AWS_SECRET_ACCESS_KEY,
  bucket: env().S3_BUCKET,
  endpoint: env().S3_ENDPOINT,
  publicEndpoint: env().S3_PUBLIC_ENDPOINT,
  forcePathStyle: env().S3_FORCE_PATH_STYLE,
  presignExpirySeconds: env().S3_PRESIGN_EXPIRY_SECONDS,
}));

export const agoraConfig = registerAs('agora', () => ({
  appId: env().AGORA_APP_ID,
  appCertificate: env().AGORA_APP_CERTIFICATE,
  tokenExpirySeconds: env().AGORA_TOKEN_EXPIRY_SECONDS,
}));

export const zegoConfig = registerAs('zego', () => ({
  appId: env().ZEGO_APP_ID,
  serverSecret: env().ZEGO_SERVER_SECRET,
  tokenExpirySeconds: env().ZEGO_TOKEN_EXPIRY_SECONDS,
}));

export const audioRoomConfig = registerAs('audioRoom', () => ({
  defaultMaxParticipants: env().AUDIO_ROOM_DEFAULT_MAX_PARTICIPANTS,
  maxParticipantsCap: env().AUDIO_ROOM_MAX_PARTICIPANTS_CAP,
  cacheTtlSeconds: env().AUDIO_ROOM_CACHE_TTL_SECONDS,
  trendingWindowSeconds: env().AUDIO_ROOM_TRENDING_WINDOW_SECONDS,
  // Seat / stage defaults (AR-1)
  defaultSpeakerSeats: env().AUDIO_ROOM_DEFAULT_SPEAKER_SEATS,
  defaultPremiumAdminSeats: env().AUDIO_ROOM_DEFAULT_PREMIUM_ADMIN_SEATS,
  seatInvitationTtlSeconds: env().AUDIO_ROOM_SEAT_INVITATION_TTL_SECONDS,
  // Chat / anti-abuse (AR-4)
  chat: {
    messageMaxLength: env().AUDIO_ROOM_CHAT_MESSAGE_MAX_LENGTH,
    maxMentions: env().AUDIO_ROOM_CHAT_MAX_MENTIONS,
    maxPins: env().AUDIO_ROOM_CHAT_MAX_PINS,
    rateMax: env().AUDIO_ROOM_CHAT_RATE_MAX,
    rateWindowSeconds: env().AUDIO_ROOM_CHAT_RATE_WINDOW_SECONDS,
    dedupWindowSeconds: env().AUDIO_ROOM_CHAT_DEDUP_WINDOW_SECONDS,
    reactRateMax: env().AUDIO_ROOM_CHAT_REACT_RATE_MAX,
    reactRateWindowSeconds: env().AUDIO_ROOM_CHAT_REACT_RATE_WINDOW_SECONDS,
    violationWindowSeconds: env().AUDIO_ROOM_CHAT_VIOLATION_WINDOW_SECONDS,
    autoMuteThreshold: env().AUDIO_ROOM_CHAT_AUTO_MUTE_THRESHOLD,
    autoKickThreshold: env().AUDIO_ROOM_CHAT_AUTO_KICK_THRESHOLD,
    autoMuteMinutes: env().AUDIO_ROOM_CHAT_AUTO_MUTE_MINUTES,
    blockedWordReloadSeconds: env().AUDIO_ROOM_CHAT_BLOCKED_WORD_RELOAD_SECONDS,
  },
  // Premium features (AR-9)
  premiumSeat: {
    priceGold: env().AUDIO_ROOM_PREMIUM_SEAT_PRICE_GOLD,
    durationDays: env().AUDIO_ROOM_PREMIUM_SEAT_DURATION_DAYS,
  },
}));

export const videoRoomConfig = registerAs('videoRoom', () => ({
  defaultMaxParticipants: env().VIDEO_ROOM_DEFAULT_MAX_PARTICIPANTS,
  maxParticipantsCap: env().VIDEO_ROOM_MAX_PARTICIPANTS_CAP,
  defaultMaxViewers: env().VIDEO_ROOM_DEFAULT_MAX_VIEWERS,
  maxViewersCap: env().VIDEO_ROOM_MAX_VIEWERS_CAP,
  heartbeatIntervalSeconds: env().VIDEO_ROOM_HEARTBEAT_INTERVAL_SECONDS,
  reconnectTimeoutSeconds: env().VIDEO_ROOM_RECONNECT_TIMEOUT_SECONDS,
  maxReconnectAttempts: env().VIDEO_ROOM_MAX_RECONNECT_ATTEMPTS,
  idleTimeoutSeconds: env().VIDEO_ROOM_IDLE_TIMEOUT_SECONDS,
  cleanupIntervalSeconds: env().VIDEO_ROOM_CLEANUP_INTERVAL_SECONDS,
  sessionTtlSeconds: env().VIDEO_ROOM_SESSION_TTL_SECONDS,
  stateTtlSeconds: env().VIDEO_ROOM_STATE_TTL_SECONDS,
  cacheTtlSeconds: env().VIDEO_ROOM_CACHE_TTL_SECONDS,
  defaultQuality: env().VIDEO_ROOM_DEFAULT_QUALITY,
  maxBitrateKbps: env().VIDEO_ROOM_MAX_BITRATE_KBPS,
  maxRoomsPerOwner: env().VIDEO_ROOM_MAX_ROOMS_PER_OWNER,
  // Media engine (VR-5)
  mediaHeartbeatTtlSeconds: env().VIDEO_ROOM_MEDIA_HEARTBEAT_TTL_SECONDS,
  mediaMonitorIntervalSeconds: env().VIDEO_ROOM_MEDIA_MONITOR_INTERVAL_SECONDS,
  mediaReconnectGraceSeconds: env().VIDEO_ROOM_MEDIA_RECONNECT_GRACE_SECONDS,
  mediaRecoveryTokenTtlSeconds: env().VIDEO_ROOM_MEDIA_RECOVERY_TOKEN_TTL_SECONDS,
  maxSubscriptionsPerUser: env().VIDEO_ROOM_MAX_SUBSCRIPTIONS_PER_USER,
  qualitySampleEvery: env().VIDEO_ROOM_MEDIA_QUALITY_SAMPLE_EVERY,
  defaultBeautyLevel: env().VIDEO_ROOM_DEFAULT_BEAUTY_LEVEL,
  // Viewer-mode audience source (VR-6): 'durable' (member-is-viewer) today;
  // 'ephemeral' (Redis-only, broadcast-scale) is a future implementation.
  viewerPresenceMode: env().VIDEO_ROOM_VIEWER_PRESENCE_MODE,
  // Moderation & safety engine (VR-16): auto-mod detector thresholds/windows,
  // cooldown, expiry-sweep cadence, and text-bound mirrors. Every moderation
  // service/detector reads thresholds through this namespace — nothing is
  // hardcoded downstream.
  moderation: {
    spamThreshold: env().VIDEO_ROOM_MOD_SPAM_THRESHOLD,
    spamWindowSec: env().VIDEO_ROOM_MOD_SPAM_WINDOW_SEC,
    floodThreshold: env().VIDEO_ROOM_MOD_FLOOD_THRESHOLD,
    floodWindowSec: env().VIDEO_ROOM_MOD_FLOOD_WINDOW_SEC,
    duplicateWindowSec: env().VIDEO_ROOM_MOD_DUP_WINDOW_SEC,
    rapidJoinLeaveThreshold: env().VIDEO_ROOM_MOD_RAPID_JOINLEAVE_THRESHOLD,
    rapidJoinLeaveWindowSec: env().VIDEO_ROOM_MOD_RAPID_JOINLEAVE_WINDOW_SEC,
    excessiveReportsThreshold: env().VIDEO_ROOM_MOD_EXCESSIVE_REPORTS_THRESHOLD,
    excessiveReportsWindowSec: env().VIDEO_ROOM_MOD_EXCESSIVE_REPORTS_WINDOW_SEC,
    warningThreshold: env().VIDEO_ROOM_MOD_WARNING_THRESHOLD,
    autoMuteMinutes: env().VIDEO_ROOM_MOD_AUTO_MUTE_MINUTES,
    autoActionCooldownSec: env().VIDEO_ROOM_MOD_AUTO_ACTION_COOLDOWN_SEC,
    expiryMonitorIntervalMs: env().VIDEO_ROOM_MOD_EXPIRY_MONITOR_INTERVAL_MS,
    reasonMax: env().VIDEO_ROOM_MOD_REASON_MAX,
    descriptionMax: env().VIDEO_ROOM_MOD_DESCRIPTION_MAX,
  },
}));

/**
 * VR-10 gift engine tuning. Read through `loadVideoRoomGiftConfig`, which
 * re-coerces the booleans (z.coerce.boolean maps "false" to true).
 */
export const videoRoomGiftConfig = registerAs('videoRoomGift', () => ({
  maxReceivers: env().VIDEO_ROOM_GIFT_MAX_RECEIVERS,
  allowRoomAll: process.env.VIDEO_ROOM_GIFT_ALLOW_ROOM_ALL ?? 'false',
  allowViewerGiftsDefault: process.env.VIDEO_ROOM_GIFT_ALLOW_VIEWER_DEFAULT ?? 'true',
  recentFeedSize: env().VIDEO_ROOM_GIFT_RECENT_FEED_SIZE,
  monitorIntervalSeconds: env().VIDEO_ROOM_GIFT_MONITOR_INTERVAL_SECONDS,
  recoveryEnabled: process.env.VIDEO_ROOM_GIFT_RECOVERY_ENABLED ?? 'false',
  blockedCountries: process.env.VIDEO_ROOM_GIFT_BLOCKED_COUNTRIES ?? '',
}));

/**
 * VR-11 treasure engine. Booleans are read raw rather than through `env()`:
 * `z.coerce.boolean()` maps the string "false" to `true`, so an operator
 * disabling recovery would silently enable it. `loadVideoRoomTreasureConfig`
 * applies `toBool`, which honours "false"/"0"/"no"/"off".
 */
export const videoRoomTreasureConfig = registerAs('videoRoomTreasure', () => ({
  enabled: process.env.VIDEO_ROOM_TREASURE_ENABLED ?? 'true',
  poolBps: env().VIDEO_ROOM_TREASURE_POOL_BPS,
  winnerCount: env().VIDEO_ROOM_TREASURE_WINNER_COUNT,
  oversampleFactor: env().VIDEO_ROOM_TREASURE_OVERSAMPLE_FACTOR,
  oversampleMin: env().VIDEO_ROOM_TREASURE_OVERSAMPLE_MIN,
  minStaySeconds: env().VIDEO_ROOM_TREASURE_MIN_STAY_SECONDS,
  minActivityEvents: env().VIDEO_ROOM_TREASURE_MIN_ACTIVITY_EVENTS,
  progressEmitPerSecond: env().VIDEO_ROOM_TREASURE_PROGRESS_EMIT_PER_SECOND,
  orphanTimeoutSeconds: env().VIDEO_ROOM_TREASURE_ORPHAN_TIMEOUT_SECONDS,
  recoveryEnabled: process.env.VIDEO_ROOM_TREASURE_RECOVERY_ENABLED ?? 'false',
  monitorIntervalSeconds: env().VIDEO_ROOM_TREASURE_MONITOR_INTERVAL_SECONDS,
}));

/**
 * VR-12 PK battle engine. Booleans are read raw rather than through `env()`:
 * `z.coerce.boolean()` maps the string "false" to `true`, so an operator
 * disabling recovery would silently enable it. `loadVideoRoomPkConfig`
 * applies `toBool`, which honours "false"/"0"/"no"/"off".
 */
export const videoRoomPkConfig = registerAs('videoRoomPk', () => ({
  enabled: process.env.VIDEO_ROOM_PK_ENABLED ?? 'true',
  countdownSeconds: env().VIDEO_ROOM_PK_COUNTDOWN_SECONDS,
  minDurationSeconds: env().VIDEO_ROOM_PK_MIN_DURATION_SECONDS,
  maxDurationSeconds: env().VIDEO_ROOM_PK_MAX_DURATION_SECONDS,
  defaultDurationSeconds: env().VIDEO_ROOM_PK_DEFAULT_DURATION_SECONDS,
  invitationTtlSeconds: env().VIDEO_ROOM_PK_INVITATION_TTL_SECONDS,
  poolBps: env().VIDEO_ROOM_PK_POOL_BPS,
  winnerBps: env().VIDEO_ROOM_PK_WINNER_BPS,
  participationBps: env().VIDEO_ROOM_PK_PARTICIPATION_BPS,
  bonusBps: env().VIDEO_ROOM_PK_BONUS_BPS,
  multiplierCapBps: env().VIDEO_ROOM_PK_MULTIPLIER_CAP_BPS,
  vipBonusBpsPerTier: env().VIDEO_ROOM_PK_VIP_BONUS_BPS_PER_TIER,
  eventBonusBps: env().VIDEO_ROOM_PK_EVENT_BONUS_BPS,
  eventMultiplierEnabled: process.env.VIDEO_ROOM_PK_EVENT_MULTIPLIER_ENABLED ?? 'false',
  scoreEmitPerSecond: env().VIDEO_ROOM_PK_SCORE_EMIT_PER_SECOND,
  recoveryEnabled: process.env.VIDEO_ROOM_PK_RECOVERY_ENABLED ?? 'false',
  monitorIntervalSeconds: env().VIDEO_ROOM_PK_MONITOR_INTERVAL_SECONDS,
  orphanTimeoutSeconds: env().VIDEO_ROOM_PK_ORPHAN_TIMEOUT_SECONDS,
  recoveryGraceSeconds: env().VIDEO_ROOM_PK_RECOVERY_GRACE_SECONDS,
  maxPerSweep: env().VIDEO_ROOM_PK_MAX_PER_SWEEP,
}));

export const videoRoomRankingConfig = registerAs('videoRoomRanking', () => ({
  enabled: process.env.VIDEO_ROOM_RANKING_ENABLED,
  cacheTtlSeconds: process.env.VIDEO_ROOM_RANKING_CACHE_TTL_SECONDS,
  dedupeTtlSeconds: process.env.VIDEO_ROOM_RANKING_DEDUPE_TTL_SECONDS,
  roomLadderTtlSeconds: process.env.VIDEO_ROOM_RANKING_ROOM_LADDER_TTL_SECONDS,
  derivedLadderTtlSeconds: process.env.VIDEO_ROOM_RANKING_DERIVED_LADDER_TTL_SECONDS,
  coalesceWindowMs: process.env.VIDEO_ROOM_RANKING_COALESCE_WINDOW_MS,
  broadcastTopN: process.env.VIDEO_ROOM_RANKING_BROADCAST_TOP_N,
  hostCoinWeight: process.env.VIDEO_ROOM_RANKING_HOST_COIN_WEIGHT,
  hostGiftWeight: process.env.VIDEO_ROOM_RANKING_HOST_GIFT_WEIGHT,
  hostWatchSecondWeight: process.env.VIDEO_ROOM_RANKING_HOST_WATCH_SECOND_WEIGHT,
  hostPeakViewerWeight: process.env.VIDEO_ROOM_RANKING_HOST_PEAK_VIEWER_WEIGHT,
  hostPkWinWeight: process.env.VIDEO_ROOM_RANKING_HOST_PK_WIN_WEIGHT,
  hostTreasureEventWeight: process.env.VIDEO_ROOM_RANKING_HOST_TREASURE_EVENT_WEIGHT,
  roomGiftCoinWeight: process.env.VIDEO_ROOM_RANKING_ROOM_GIFT_COIN_WEIGHT,
  roomPeakViewerWeight: process.env.VIDEO_ROOM_RANKING_ROOM_PEAK_VIEWER_WEIGHT,
  roomAvgWatchSecondWeight: process.env.VIDEO_ROOM_RANKING_ROOM_AVG_WATCH_SECOND_WEIGHT,
  roomPkCountWeight: process.env.VIDEO_ROOM_RANKING_ROOM_PK_COUNT_WEIGHT,
  roomTreasureCountWeight: process.env.VIDEO_ROOM_RANKING_ROOM_TREASURE_COUNT_WEIGHT,
  pkWinWeight: process.env.VIDEO_ROOM_RANKING_PK_WIN_WEIGHT,
  pkLossWeight: process.env.VIDEO_ROOM_RANKING_PK_LOSS_WEIGHT,
  pkScoreWeight: process.env.VIDEO_ROOM_RANKING_PK_SCORE_WEIGHT,
  pkGiftCoinWeight: process.env.VIDEO_ROOM_RANKING_PK_GIFT_COIN_WEIGHT,
  retentionHourlyDays: process.env.VIDEO_ROOM_RANKING_RETENTION_HOURLY_DAYS,
  retentionDailyDays: process.env.VIDEO_ROOM_RANKING_RETENTION_DAILY_DAYS,
  retentionWeeklyDays: process.env.VIDEO_ROOM_RANKING_RETENTION_WEEKLY_DAYS,
  maxCustomRangeDays: process.env.VIDEO_ROOM_RANKING_MAX_CUSTOM_RANGE_DAYS,
}));

export const chatConfig = registerAs('chat', () => ({
  messageMaxLength: env().CHAT_MESSAGE_MAX_LENGTH,
  maxAttachments: env().CHAT_MAX_ATTACHMENTS,
  rateMax: env().CHAT_RATE_MAX,
  rateWindowSeconds: env().CHAT_RATE_WINDOW_SECONDS,
  typingTtlSeconds: env().CHAT_TYPING_TTL_SECONDS,
  unreadCacheTtlSeconds: env().CHAT_UNREAD_CACHE_TTL_SECONDS,
  editWindowSeconds: env().CHAT_EDIT_WINDOW_SECONDS,
  maxPinned: env().CHAT_MAX_PINNED,
  maxStarred: env().CHAT_MAX_STARRED,
  linkPreviewEnabled: env().CHAT_LINK_PREVIEW_ENABLED,
  linkPreviewTimeoutMs: env().CHAT_LINK_PREVIEW_TIMEOUT_MS,
  linkPreviewMaxBytes: env().CHAT_LINK_PREVIEW_MAX_BYTES,
  linkPreviewMaxRedirects: env().CHAT_LINK_PREVIEW_MAX_REDIRECTS,
  linkPreviewTtlDays: env().CHAT_LINK_PREVIEW_TTL_DAYS,
  linkPreviewDenylist: env()
    .CHAT_LINK_PREVIEW_DENYLIST.split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  syncMaxWindowDays: env().CHAT_SYNC_MAX_WINDOW_DAYS,
  syncMaxMessages: env().CHAT_SYNC_MAX_MESSAGES,
  syncMaxConversations: env().CHAT_SYNC_MAX_CONVERSATIONS,
}));

export const videoRoomChatConfig = registerAs('videoRoomChat', () => ({
  messageMaxLength: process.env.VIDEO_ROOM_CHAT_MESSAGE_MAX_LENGTH ?? 500,
  maxMentions: process.env.VIDEO_ROOM_CHAT_MAX_MENTIONS ?? 10,
  maxPins: process.env.VIDEO_ROOM_CHAT_MAX_PINS ?? 3,
  rateMax: process.env.VIDEO_ROOM_CHAT_RATE_MAX ?? 20,
  rateWindowSeconds: process.env.VIDEO_ROOM_CHAT_RATE_WINDOW_SECONDS ?? 60,
  dedupWindowSeconds: process.env.VIDEO_ROOM_CHAT_DEDUP_WINDOW_SECONDS ?? 30,
  floodBurstMax: process.env.VIDEO_ROOM_CHAT_FLOOD_BURST_MAX ?? 5,
  floodBurstWindowSeconds: process.env.VIDEO_ROOM_CHAT_FLOOD_BURST_WINDOW_SECONDS ?? 2,
  cooldownSteps: process.env.VIDEO_ROOM_CHAT_COOLDOWN_STEPS ?? '10,30,120',
  recentBufferSize: process.env.VIDEO_ROOM_CHAT_RECENT_BUFFER_SIZE ?? 100,
  recentBufferTtlSeconds: process.env.VIDEO_ROOM_CHAT_RECENT_BUFFER_TTL_SECONDS ?? 3600,
  typingTtlSeconds: process.env.VIDEO_ROOM_CHAT_TYPING_TTL_SECONDS ?? 5,
  recallWindowSeconds: process.env.VIDEO_ROOM_CHAT_RECALL_WINDOW_SECONDS ?? 120,
  editWindowSeconds: process.env.VIDEO_ROOM_CHAT_EDIT_WINDOW_SECONDS ?? 900,
  receiptThrottleMs: process.env.VIDEO_ROOM_CHAT_RECEIPT_THROTTLE_MS ?? 2000,
  systemMessageBroadcastOnlyAboveViewers:
    process.env.VIDEO_ROOM_CHAT_SYSMSG_BROADCAST_ONLY_ABOVE_VIEWERS ?? 200,
  systemMessageSuppressAboveViewers:
    process.env.VIDEO_ROOM_CHAT_SYSMSG_SUPPRESS_ABOVE_VIEWERS ?? 2000,
}));

export const callsConfig = registerAs('calls', () => ({
  ringTimeoutSeconds: env().CALL_RING_TIMEOUT_SECONDS,
  maxDurationSeconds: env().CALL_MAX_DURATION_SECONDS,
  connectTimeoutSeconds: env().CALL_CONNECT_TIMEOUT_SECONDS,
  reaperIntervalSeconds: env().CALL_REAPER_INTERVAL_SECONDS,
  rateMax: env().CALL_RATE_MAX,
  rateWindowSeconds: env().CALL_RATE_WINDOW_SECONDS,
  writeChatLog: env().CALL_WRITE_CHAT_LOG,
}));

export const giftConfig = registerAs('gift', () => ({
  // EXP awarded per gold coin of gift value (sender/receiver).
  senderExpPerCoin: env().GIFT_SENDER_EXP_PER_COIN,
  receiverExpPerCoin: env().GIFT_RECEIVER_EXP_PER_COIN,
  // Anti-abuse send rate: at most rateMax sends per rateWindowSeconds per sender.
  rateMax: env().GIFT_RATE_MAX,
  rateWindowSeconds: env().GIFT_RATE_WINDOW_SECONDS,
  // Days a leaderboard ZSET is retained (TTL applied on first write of a bucket).
  leaderboardRetentionDays: env().GIFT_LEADERBOARD_RETENTION_DAYS,
}));

export const queueConfig = registerAs('queue', () => ({
  prefix: env().QUEUE_PREFIX,
  concurrency: env().QUEUE_CONCURRENCY,
  defaultAttempts: env().QUEUE_DEFAULT_ATTEMPTS,
  metricsIntervalMs: env().QUEUE_METRICS_INTERVAL_MS,
  dashboardRoute: env().QUEUE_DASHBOARD_ROUTE,
  dashboardUser: env().QUEUE_DASHBOARD_USER,
  dashboardPassword: env().QUEUE_DASHBOARD_PASSWORD,
}));

export const configurations = [
  appConfig,
  monitoringConfig,
  tracingConfig,
  databaseConfig,
  redisConfig,
  jwtConfig,
  authConfig,
  otpConfig,
  otpProvidersConfig,
  securityConfig,
  sessionConfig,
  profileConfig,
  pushConfig,
  pushProvidersConfig,
  authorizationConfig,
  paymentsConfig,
  privacyConfig,
  socialConfig,
  storageConfig,
  agoraConfig,
  zegoConfig,
  audioRoomConfig,
  videoRoomConfig,
  videoRoomChatConfig,
  videoRoomGiftConfig,
  videoRoomTreasureConfig,
  videoRoomPkConfig,
  videoRoomRankingConfig,
  chatConfig,
  callsConfig,
  giftConfig,
  queueConfig,
];
