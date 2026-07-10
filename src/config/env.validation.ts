import { z } from 'zod';

/**
 * Single source of truth for every environment variable the platform reads.
 * Validated once at boot (fail-fast): a missing or malformed value stops the
 * process before any module initialises. Extend this schema as modules land.
 */
/** Optional URL that also accepts an empty string (treated as unset). */
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());

export const envSchema = z.object({
  // ---- Runtime ----
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().default('api'),
  CORS_ORIGINS: z.string().default('*'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ---- Database (Postgres / Prisma) ----
  DATABASE_URL: z.string().url(),
  // Direct-to-Postgres URL for migrations/introspection (bypasses PgBouncer).
  // Falls back to DATABASE_URL when unset — see databaseConfig.
  DIRECT_URL: optionalUrl,
  // Prisma client-side pool size; unset = Prisma default (num_cpus*2+1).
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().positive().optional(),
  // Seconds to wait for a free connection from the pool before erroring.
  DATABASE_POOL_TIMEOUT: z.coerce.number().int().nonnegative().default(10),
  // Seconds to wait to establish a new connection.
  DATABASE_CONNECT_TIMEOUT: z.coerce.number().int().positive().default(5),

  // ---- Distributed tracing (OpenTelemetry, AR-15) ----
  // Off by default; when true, main.ts's tracing bootstrap starts the Node SDK
  // and exports spans over OTLP/HTTP to the collector below.
  OTEL_ENABLED: z.coerce.boolean().default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://localhost:4318'),
  OTEL_SERVICE_NAME: z.string().default('soulzaa-backend'),
  OTEL_SERVICE_VERSION: z.string().optional(),
  // Parent-based head-sampling ratio for new root traces (0..1).
  OTEL_TRACES_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(1),

  // ---- Redis (cache, presence, locks, leaderboards, socket adapter, BullMQ) ----
  REDIS_URL: z.string().url(),
  // Optional comma-separated `host:port` list. When set, the client runs in
  // Cluster mode across these startup nodes instead of standalone REDIS_URL.
  REDIS_CLUSTER_NODES: z.string().optional(),

  // ---- Auth / JWT ----
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_REFRESH_TTL: z.string().default('30d'),
  // bcrypt cost factor for password hashing.
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().positive().default(12),

  // ---- OTP (mobile + email one-time codes) ----
  OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
  // Code lifetime — PRD "60 Second Timer".
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Max re-sends per destination before it is temporarily blocked.
  OTP_MAX_RESENDS: z.coerce.number().int().positive().default(5),
  // Minimum gap between successive re-sends to the same destination.
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(30),
  // How long a destination stays blocked after abuse (too many attempts/resends).
  OTP_BLOCK_SECONDS: z.coerce.number().int().positive().default(900),
  // Maintenance: cron for pruning expired OTP audit rows + retention window.
  OTP_CLEANUP_CRON: z.string().default('*/15 * * * *'),
  OTP_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
  // Delivery providers. SMS: console | twilio | msg91 | aws_sns. Email: console | smtp.
  OTP_SMS_PROVIDER: z.enum(['console', 'twilio', 'msg91', 'aws_sns']).default('console'),
  OTP_EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
  // Provider credentials (optional; required only when that provider is selected).
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_SENDER_ID: z.string().optional(),
  // AWS SNS reuses AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY below.

  // ---- Login security (attempt tracking + temporary lock) ----
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_SECONDS: z.coerce.number().int().positive().default(900),
  // Password-reset token lifetime.
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Minimum account age in years (18+ platform).
  MIN_USER_AGE: z.coerce.number().int().positive().default(18),

  // ---- User profiles ----
  // Public base URL for serving media (CDN). Empty → fall back to presigned GET.
  MEDIA_PUBLIC_BASE_URL: optionalUrl,
  // Base URL + deep-link scheme for profile sharing.
  SHARE_BASE_URL: z.string().url().default('https://soulzaa.app'),
  APP_DEEPLINK_SCHEME: z.string().default('soulzaa://'),
  // Composed-profile cache lifetime (seconds).
  PROFILE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // ---- Push notifications (device login alerts, FCM/APNS) ----
  PUSH_PROVIDER: z.enum(['console', 'fcm', 'apns']).default('console'),
  // Push a login alert to a user's other devices on a suspicious login.
  SUSPICIOUS_LOGIN_ALERTS: z.coerce.boolean().default(true),
  // Firebase Cloud Messaging (required only when PUSH_PROVIDER=fcm).
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  FCM_PRIVATE_KEY: z.string().optional(),
  // Apple Push Notification service (required only when PUSH_PROVIDER=apns).
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  APNS_PRIVATE_KEY: z.string().optional(),

  // ---- Privacy ----
  // Cache lifetime (seconds) for privacy settings + block-set checks.
  PRIVACY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Default visibility applied to new users' privacy settings.
  PRIVACY_DEFAULT_VISIBILITY: z
    .enum(['EVERYONE', 'FRIENDS_ONLY', 'FOLLOWERS_ONLY', 'NOBODY'])
    .default('EVERYONE'),

  // ---- Sessions ----
  // Max concurrent active sessions per user; the oldest is evicted past this.
  SESSION_MAX_CONCURRENT: z.coerce.number().int().positive().default(5),
  // Idle window (seconds): a session expires if unused for this long.
  SESSION_INACTIVITY_SECONDS: z.coerce.number().int().positive().default(1800),
  // Absolute session lifetime cap (seconds); defaults to the 30d refresh window.
  SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  // When true, a changed client IP on refresh is treated as hijack (strict).
  SESSION_HIJACK_STRICT_IP: z.coerce.boolean().default(false),

  // ---- Social login (Google / Apple ID-token verification) ----
  // Comma-separated allowed audiences (client ids). Empty disables that provider.
  GOOGLE_CLIENT_IDS: z.string().optional(),
  APPLE_CLIENT_IDS: z.string().optional(),
  APPLE_ISSUER: z.string().default('https://appleid.apple.com'),

  // ---- AWS S3 (media storage) ----
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().default('soulzaa-media'),
  S3_ENDPOINT: optionalUrl, // for S3-compatible/local (MinIO), used server→S3
  // Host used to SIGN presigned upload/download URLs when it must differ from
  // S3_ENDPOINT — e.g. local dev where the backend reaches MinIO via localhost
  // but a physical device must reach it via the machine's LAN IP. Leave unset in
  // prod (presigns then use S3_ENDPOINT / real S3).
  S3_PUBLIC_ENDPOINT: optionalUrl,
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  S3_PRESIGN_EXPIRY_SECONDS: z.coerce.number().int().positive().default(900),

  // ---- Agora (audio/video infrastructure) ----
  AGORA_APP_ID: z.string().optional(),
  AGORA_APP_CERTIFICATE: z.string().optional(),
  AGORA_TOKEN_EXPIRY_SECONDS: z.coerce.number().int().positive().default(3600),

  // ---- ZEGOCLOUD (Audio Room voice) ----
  // Numeric ZEGO AppID and the 32-byte server secret (from the ZEGO console).
  ZEGO_APP_ID: z.coerce.number().int().positive().optional(),
  ZEGO_SERVER_SECRET: z.string().optional(),
  ZEGO_TOKEN_EXPIRY_SECONDS: z.coerce.number().int().positive().default(3600),

  // ---- Audio Rooms ----
  // Default participant cap applied to a new room when not specified.
  AUDIO_ROOM_DEFAULT_MAX_PARTICIPANTS: z.coerce.number().int().positive().default(50),
  // Hard upper bound a room owner may configure.
  AUDIO_ROOM_MAX_PARTICIPANTS_CAP: z.coerce.number().int().positive().default(500),
  // Room-snapshot cache lifetime (seconds).
  AUDIO_ROOM_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  // Sliding window (seconds) over which trending activity is scored.
  AUDIO_ROOM_TRENDING_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  // Default stage layout for a new room (owner seat is always seat 0, not counted here).
  AUDIO_ROOM_DEFAULT_SPEAKER_SEATS: z.coerce.number().int().nonnegative().default(8),
  AUDIO_ROOM_DEFAULT_PREMIUM_ADMIN_SEATS: z.coerce.number().int().nonnegative().default(0),
  // How long a seat invitation stays valid before it expires.
  AUDIO_ROOM_SEAT_INVITATION_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  // ---- Chat / anti-abuse (AR-4) ----
  AUDIO_ROOM_CHAT_MESSAGE_MAX_LENGTH: z.coerce.number().int().positive().default(1000),
  AUDIO_ROOM_CHAT_MAX_MENTIONS: z.coerce.number().int().nonnegative().default(10),
  AUDIO_ROOM_CHAT_MAX_PINS: z.coerce.number().int().positive().default(5),
  // Rolling rate limit: at most RATE_MAX messages per RATE_WINDOW_SECONDS per user/room.
  AUDIO_ROOM_CHAT_RATE_MAX: z.coerce.number().int().positive().default(10),
  AUDIO_ROOM_CHAT_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  // Duplicate-message suppression window (identical content by the same sender).
  AUDIO_ROOM_CHAT_DEDUP_WINDOW_SECONDS: z.coerce.number().int().positive().default(30),
  // Ephemeral reaction burst rate limit.
  AUDIO_ROOM_CHAT_REACT_RATE_MAX: z.coerce.number().int().positive().default(15),
  AUDIO_ROOM_CHAT_REACT_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  // Blocked-word violation history window + auto-escalation thresholds (rolling count).
  AUDIO_ROOM_CHAT_VIOLATION_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  AUDIO_ROOM_CHAT_AUTO_MUTE_THRESHOLD: z.coerce.number().int().positive().default(3),
  AUDIO_ROOM_CHAT_AUTO_KICK_THRESHOLD: z.coerce.number().int().positive().default(6),
  AUDIO_ROOM_CHAT_AUTO_MUTE_MINUTES: z.coerce.number().int().positive().default(15),
  // How often BlockedWordService reloads the dictionary from the DB.
  AUDIO_ROOM_CHAT_BLOCKED_WORD_RELOAD_SECONDS: z.coerce.number().int().positive().default(300),
  // ---- Premium features (AR-9) ----
  AUDIO_ROOM_PREMIUM_SEAT_PRICE_GOLD: z.coerce.number().int().positive().default(50_000),
  AUDIO_ROOM_PREMIUM_SEAT_DURATION_DAYS: z.coerce.number().int().positive().default(30),

  // ---- Gifts (AR-5) ----
  GIFT_CREATOR_EARNING_RATE_PERCENT: z.coerce.number().int().min(0).max(100).default(30),
  GIFT_SENDER_EXP_PER_COIN: z.coerce.number().min(0).default(1),
  GIFT_RECEIVER_EXP_PER_COIN: z.coerce.number().min(0).default(1),
  GIFT_RATE_MAX: z.coerce.number().int().positive().default(20),
  GIFT_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  GIFT_LEADERBOARD_RETENTION_DAYS: z.coerce.number().int().positive().default(60),

  // ---- Queue (BullMQ) ----
  QUEUE_PREFIX: z.string().default('soulzaa'),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(5),
  QUEUE_DEFAULT_ATTEMPTS: z.coerce.number().int().positive().default(3),
  QUEUE_METRICS_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  // Bull Board mounts an Express router (bypasses Nest guards), so it is
  // protected with HTTP Basic auth. Change the password before exposing it.
  QUEUE_DASHBOARD_ROUTE: z.string().default('/admin/queues'),
  QUEUE_DASHBOARD_USER: z.string().default('admin'),
  QUEUE_DASHBOARD_PASSWORD: z.string().default('soulzaa'),

  // ---- Observability ----
  METRICS_ENABLED: z.coerce.boolean().default(true),
  // Slow-operation thresholds (ms) for warning/error logs.
  SLOW_QUERY_WARN_MS: z.coerce.number().int().positive().default(100),
  SLOW_QUERY_ERROR_MS: z.coerce.number().int().positive().default(500),
  SLOW_REDIS_MS: z.coerce.number().int().positive().default(50),
  SLOW_REQUEST_MS: z.coerce.number().int().positive().default(1000),
  // Liveness fails if the mean event-loop lag exceeds this (ms).
  LIVENESS_MAX_EVENT_LOOP_LAG_MS: z.coerce.number().int().positive().default(200),
});

export type Env = z.infer<typeof envSchema>;

/**
 * `validate` hook for @nestjs/config. Throws a readable aggregated error when
 * any variable is missing or invalid.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`❌ Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
