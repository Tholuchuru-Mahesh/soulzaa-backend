import { z } from 'zod';

/**
 * Single source of truth for every environment variable the platform reads.
 * Validated once at boot (fail-fast): a missing or malformed value stops the
 * process before any module initialises. Extend this schema as modules land.
 */
/** Optional URL that also accepts an empty string (treated as unset). */
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());

/** Optional coerced positive integer that also accepts an empty string (treated as unset). */
const optionalCoercedPositiveInt = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.coerce.number().int().positive().optional(),
);

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
  DATABASE_CONNECTION_LIMIT: optionalCoercedPositiveInt,
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

  // ---- Payments ----
  // Receipt verification credentials. Each is optional: an unconfigured provider
  // REJECTS receipts rather than accepting them, so a missing secret can never
  // become free coins.
  // Android applicationId of the published app, e.g. `com.soulzaa.app`. Part of
  // every Android Publisher API URL.
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  // Service-account credentials JSON with Android Publisher access, as a single
  // string. Used to mint the OAuth token for purchase verification.
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().optional(),
  // Expected `aud` when verifying the OIDC token on a Pub/Sub push. Without it
  // the RTDN webhook rejects every delivery rather than trusting the caller.
  GOOGLE_RTDN_PUSH_AUDIENCE: z.string().optional(),
  // Expected `email` claim on that same OIDC token — the Pub/Sub subscription's
  // service account. `verifyIdToken` alone only proves the token is genuinely
  // Google-signed for the (guessable) audience URL, not who minted it; without
  // this the RTDN webhook rejects every delivery rather than trusting any
  // Google account.
  GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  // App Store shared secret for the verifyReceipt endpoint.
  APPLE_IAP_SHARED_SECRET: z.string().optional(),
  // Use Apple's sandbox verification host (development builds).
  APPLE_IAP_USE_SANDBOX: z.coerce.boolean().default(false),
  // Razorpay key secret — signs `{order_id}|{payment_id}`.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Stripe webhook signing secret (`whsec_...`).
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Allows the MOCK_GATEWAY provider to approve receipts. Must stay false in
  // production — it is an unauthenticated path to crediting a wallet.
  PAYMENTS_ALLOW_MOCK_GATEWAY: z.coerce.boolean().default(false),

  // ---- Authorization (RBAC) ----
  // Cache lifetime (seconds) for resolved permissions, roles and geographic scopes.
  // Bounds how long a role change can stay invisible if an invalidation is missed.
  AUTHORIZATION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Whether a STATE or REGION scope also matches users who have no value at
  // that level but sit in the right country. Required while location data is
  // being backfilled — country is the only level recoverable from the old
  // free-text field, so without it every Official's console is empty. Set to
  // false once stateId/regionId coverage is complete to enforce exact scope.
  AUTHORIZATION_SCOPE_COUNTRY_BRIDGE: z.coerce.boolean().default(true),

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
  FACEBOOK_APP_ID: z.string().optional(),
  FACEBOOK_APP_SECRET: z.string().optional(),

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

  // ---- KYC document verification (role request documents) ----
  // Defaults to 'none': without a provider contract the pipeline runs local
  // integrity checks only, exactly as it does today. Turning this on is what
  // makes the API able to tell an Aadhaar card from a photograph of a dog.
  KYC_PROVIDER: z.enum(['none', 'signzy', 'idfy']).default('none'),
  KYC_PROVIDER_BASE_URL: optionalUrl,
  KYC_PROVIDER_API_KEY: z.string().optional(),
  // IDfy authenticates with an account id alongside the key; Signzy does not.
  KYC_PROVIDER_ACCOUNT_ID: z.string().optional(),
  KYC_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  // ---- Agora (audio/video infrastructure) ----
  AGORA_APP_ID: z.string().optional(),
  AGORA_APP_CERTIFICATE: z.string().optional(),
  AGORA_TOKEN_EXPIRY_SECONDS: z.coerce.number().int().positive().default(3600),

  // ---- ZEGOCLOUD (Audio Room voice) ----
  // Numeric ZEGO AppID and the 32-byte server secret (from the ZEGO console).
  ZEGO_APP_ID: optionalCoercedPositiveInt,
  ZEGO_SERVER_SECRET: z.string().optional(),
  ZEGO_TOKEN_EXPIRY_SECONDS: z.coerce.number().int().positive().default(3600),

  // ---- Google Geocoding (self-service user location capture) ----
  GOOGLE_GEOCODING_API_KEY: z.string().optional(),

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
  AUDIO_ROOM_DEFAULT_PREMIUM_ADMIN_SEATS: z.coerce.number().int().nonnegative().default(1),
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

  // ---- Video Rooms (VR-0 foundation) ----
  // Default / hard-cap seat-holder (participant) counts for a new room.
  VIDEO_ROOM_DEFAULT_MAX_PARTICIPANTS: z.coerce.number().int().positive().default(12),
  VIDEO_ROOM_MAX_PARTICIPANTS_CAP: z.coerce.number().int().positive().default(20),
  // Default / hard-cap audience (viewer) counts for a new room.
  VIDEO_ROOM_DEFAULT_MAX_VIEWERS: z.coerce.number().int().positive().default(500),
  VIDEO_ROOM_MAX_VIEWERS_CAP: z.coerce.number().int().positive().default(5000),
  // Client heartbeat cadence (seconds) the session layer expects.
  VIDEO_ROOM_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(25),
  // Grace window for a dropped client to reconnect before its session is reclaimed.
  VIDEO_ROOM_RECONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  VIDEO_ROOM_MAX_RECONNECT_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Idle host/room timeout (seconds) before the room is considered dormant.
  VIDEO_ROOM_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  // How often the session/presence expiry sweep runs (seconds).
  VIDEO_ROOM_CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  // Per-session heartbeat TTL: a session with no heartbeat within this window is stale.
  VIDEO_ROOM_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(90),
  // Room state-snapshot cache TTL (seconds).
  VIDEO_ROOM_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Room read-snapshot cache TTL (seconds).
  VIDEO_ROOM_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  // Default stream quality advertised to clients (label only in VR-0).
  VIDEO_ROOM_DEFAULT_QUALITY: z.enum(['SD', 'HD', 'FHD']).default('HD'),
  // Upper bitrate (kbps) advertised to clients.
  VIDEO_ROOM_MAX_BITRATE_KBPS: z.coerce.number().int().positive().default(2500),
  // Max concurrent non-deleted rooms one owner may host (VR-2 lifecycle cap).
  // Default 1 mirrors Audio's one-room rule; tunable without a migration.
  VIDEO_ROOM_MAX_ROOMS_PER_OWNER: z.coerce.number().int().positive().default(1),
  // Viewer-mode audience source (VR-6): 'durable' (member-is-viewer, default) or
  // 'ephemeral' (Redis-only, broadcast-scale — future implementation).
  VIDEO_ROOM_VIEWER_PRESENCE_MODE: z.enum(['durable', 'ephemeral']).default('durable'),

  // ---- Video Room media engine (VR-5) ----
  VIDEO_ROOM_MEDIA_HEARTBEAT_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  VIDEO_ROOM_MEDIA_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
  VIDEO_ROOM_MEDIA_RECONNECT_GRACE_SECONDS: z.coerce.number().int().positive().default(60),
  VIDEO_ROOM_MEDIA_RECOVERY_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  VIDEO_ROOM_MAX_SUBSCRIPTIONS_PER_USER: z.coerce.number().int().positive().default(20),
  VIDEO_ROOM_MEDIA_QUALITY_SAMPLE_EVERY: z.coerce.number().int().positive().default(6),
  VIDEO_ROOM_DEFAULT_BEAUTY_LEVEL: z.coerce.number().int().min(0).max(100).default(0),
  // ---- VR-10 gift engine ----
  // NOTE: the boolean flags are re-coerced in video-room-gift.config.ts, because
  // z.coerce.boolean() maps the string "false" to true.
  VIDEO_ROOM_GIFT_MAX_RECEIVERS: z.coerce.number().int().positive().max(50).default(9),
  VIDEO_ROOM_GIFT_ALLOW_ROOM_ALL: z.coerce.boolean().default(false),
  VIDEO_ROOM_GIFT_ALLOW_VIEWER_DEFAULT: z.coerce.boolean().default(true),
  VIDEO_ROOM_GIFT_RECENT_FEED_SIZE: z.coerce.number().int().positive().max(500).default(50),
  VIDEO_ROOM_GIFT_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
  VIDEO_ROOM_GIFT_RECOVERY_ENABLED: z.coerce.boolean().default(false),
  /** Comma-separated ISO-3166-1 alpha-2 codes barred from gifting (regulatory). */
  VIDEO_ROOM_GIFT_BLOCKED_COUNTRIES: z.string().default(''),

  // ---- VR-11 treasure engine ----
  // Booleans (VIDEO_ROOM_TREASURE_ENABLED / _RECOVERY_ENABLED) are deliberately
  // absent: z.coerce.boolean() maps the string "false" to true, so the config
  // loader reads them raw and applies toBool instead.
  VIDEO_ROOM_TREASURE_POOL_BPS: z.coerce.number().int().min(0).max(10_000).default(1000),
  VIDEO_ROOM_TREASURE_WINNER_COUNT: z.coerce.number().int().positive().max(100).default(3),
  VIDEO_ROOM_TREASURE_OVERSAMPLE_FACTOR: z.coerce.number().int().positive().max(20).default(3),
  VIDEO_ROOM_TREASURE_OVERSAMPLE_MIN: z.coerce.number().int().positive().max(1000).default(50),
  VIDEO_ROOM_TREASURE_MIN_STAY_SECONDS: z.coerce.number().int().min(0).default(120),
  VIDEO_ROOM_TREASURE_MIN_ACTIVITY_EVENTS: z.coerce.number().int().min(0).default(0),
  VIDEO_ROOM_TREASURE_PROGRESS_EMIT_PER_SECOND: z.coerce.number().int().min(0).max(100).default(5),
  VIDEO_ROOM_TREASURE_ORPHAN_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  VIDEO_ROOM_TREASURE_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),

  // ---- VR-12 PK battle engine ----
  // Booleans are `.optional()` strings, not `z.coerce.boolean()`: that coercion
  // maps the string "false" to true, so the config loader reads them raw and
  // applies toBool instead. All 20 vars are listed here (rather than omitted,
  // as VR-11's booleans were) so a typo or unset var is never a silent gap.
  VIDEO_ROOM_PK_ENABLED: z.string().optional(),
  VIDEO_ROOM_PK_COUNTDOWN_SECONDS: z.coerce.number().int().positive().optional(),
  VIDEO_ROOM_PK_MIN_DURATION_SECONDS: z.coerce.number().int().positive().optional(),
  VIDEO_ROOM_PK_MAX_DURATION_SECONDS: z.coerce.number().int().positive().optional(),
  VIDEO_ROOM_PK_DEFAULT_DURATION_SECONDS: z.coerce.number().int().positive().optional(),
  VIDEO_ROOM_PK_INVITATION_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  VIDEO_ROOM_PK_POOL_BPS: z.coerce.number().int().min(0).max(10_000).optional(),
  VIDEO_ROOM_PK_WINNER_BPS: z.coerce.number().int().min(0).max(10_000).optional(),
  VIDEO_ROOM_PK_PARTICIPATION_BPS: z.coerce.number().int().min(0).max(10_000).optional(),
  VIDEO_ROOM_PK_BONUS_BPS: z.coerce.number().int().min(0).max(10_000).optional(),
  VIDEO_ROOM_PK_MULTIPLIER_CAP_BPS: z.coerce.number().int().positive().optional(),
  VIDEO_ROOM_PK_VIP_BONUS_BPS_PER_TIER: z.coerce.number().int().min(0).optional(),
  VIDEO_ROOM_PK_EVENT_BONUS_BPS: z.coerce.number().int().min(0).optional(),
  VIDEO_ROOM_PK_EVENT_MULTIPLIER_ENABLED: z.string().optional(),
  VIDEO_ROOM_PK_SCORE_EMIT_PER_SECOND: z.coerce.number().int().positive().max(100).optional(),
  VIDEO_ROOM_PK_RECOVERY_ENABLED: z.string().optional(),
  VIDEO_ROOM_PK_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
  VIDEO_ROOM_PK_ORPHAN_TIMEOUT_SECONDS: z.coerce.number().int().positive().optional(),
  VIDEO_ROOM_PK_RECOVERY_GRACE_SECONDS: z.coerce.number().int().positive().optional(),
  VIDEO_ROOM_PK_MAX_PER_SWEEP: z.coerce.number().int().positive().optional(),

  // ---- VR-16 Moderation & safety engine ----
  // Auto-mod thresholds mirror the audio-room chat auto-mod defaults above
  // (AUDIO_ROOM_CHAT_AUTO_MUTE_THRESHOLD 3, _AUTO_KICK_THRESHOLD 6,
  // _AUTO_MUTE_MINUTES 15, _DEDUP_WINDOW_SECONDS 30).
  VIDEO_ROOM_MOD_SPAM_THRESHOLD: z.coerce.number().int().positive().default(5),
  VIDEO_ROOM_MOD_SPAM_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  VIDEO_ROOM_MOD_FLOOD_THRESHOLD: z.coerce.number().int().positive().default(10),
  VIDEO_ROOM_MOD_FLOOD_WINDOW_SEC: z.coerce.number().int().positive().default(10),
  // Duplicate-message suppression window feeding the duplicate detector.
  VIDEO_ROOM_MOD_DUP_WINDOW_SEC: z.coerce.number().int().positive().default(30),
  VIDEO_ROOM_MOD_RAPID_JOINLEAVE_THRESHOLD: z.coerce.number().int().positive().default(5),
  VIDEO_ROOM_MOD_RAPID_JOINLEAVE_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  VIDEO_ROOM_MOD_EXCESSIVE_REPORTS_THRESHOLD: z.coerce.number().int().positive().default(5),
  VIDEO_ROOM_MOD_EXCESSIVE_REPORTS_WINDOW_SEC: z.coerce.number().int().positive().default(300),
  // Informational only — a warning count crossing this never auto-escalates.
  VIDEO_ROOM_MOD_WARNING_THRESHOLD: z.coerce.number().int().positive().default(3),
  VIDEO_ROOM_MOD_AUTO_MUTE_MINUTES: z.coerce.number().int().positive().default(15),
  // Per-user cooldown after an auto action fires, suppressing repeat auto actions.
  VIDEO_ROOM_MOD_AUTO_ACTION_COOLDOWN_SEC: z.coerce.number().int().positive().default(30),
  // How often the temp-mute expiry sweep runs (ms).
  VIDEO_ROOM_MOD_EXPIRY_MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  // Mirror the fixed VIDEO_ROOM_MODERATION_REASON_MAX / _DESCRIPTION_MAX DTO
  // bounds (video-room(-moderation).constants.ts) through config, so services
  // read the same ceiling without importing the DTO-layer constants directly.
  VIDEO_ROOM_MOD_REASON_MAX: z.coerce.number().int().positive().default(500),
  VIDEO_ROOM_MOD_DESCRIPTION_MAX: z.coerce.number().int().positive().default(1000),

  // ---- Direct messaging (chat module) ----
  CHAT_MESSAGE_MAX_LENGTH: z.coerce.number().int().positive().default(4000),
  CHAT_MAX_ATTACHMENTS: z.coerce.number().int().positive().default(10),
  // Rolling send rate limit: at most RATE_MAX messages per RATE_WINDOW_SECONDS per sender.
  CHAT_RATE_MAX: z.coerce.number().int().positive().default(30),
  CHAT_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  // How long a broadcast typing/recording indicator stays live before the client expires it.
  CHAT_TYPING_TTL_SECONDS: z.coerce.number().int().positive().default(5),
  // TTL for the cached per-user unread badge total.
  CHAT_UNREAD_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  // Window within which a sender may still edit their own message.
  CHAT_EDIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  // Most conversations a user may pin at once.
  CHAT_MAX_PINNED: z.coerce.number().int().positive().default(5),
  // Most messages a user may star. Capped so a per-user table cannot grow without
  // bound — an uncapped one is an availability incident waiting to happen.
  CHAT_MAX_STARRED: z.coerce.number().int().positive().default(5000),
  // Link previews: the crawler fetches an attacker-chosen URL, so every bound here
  // is a security control, not a tuning knob. See ChatLinkPreviewService.
  CHAT_LINK_PREVIEW_ENABLED: z.coerce.boolean().default(true),
  CHAT_LINK_PREVIEW_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  CHAT_LINK_PREVIEW_MAX_BYTES: z.coerce.number().int().positive().default(524_288),
  CHAT_LINK_PREVIEW_MAX_REDIRECTS: z.coerce.number().int().nonnegative().default(3),
  // How long a scraped preview stays fresh. A confidently stale title is worse
  // than none, and FAILED is cached for the same span so a dead link is not
  // re-fetched on every render.
  CHAT_LINK_PREVIEW_TTL_DAYS: z.coerce.number().int().positive().default(7),
  // Hosts the crawler will never fetch, comma-separated.
  CHAT_LINK_PREVIEW_DENYLIST: z.string().default(''),
  // Delta sync (GET /chat/sync). A client that has been away longer than the window
  // is told to cold-start instead: past some age, replaying every change costs more
  // than re-fetching the current state, and the client's cache is mostly stale anyway.
  CHAT_SYNC_MAX_WINDOW_DAYS: z.coerce.number().int().positive().default(30),
  // Messages per sync page. The client follows `nextSince` until `hasMore` is false.
  CHAT_SYNC_MAX_MESSAGES: z.coerce.number().int().positive().max(1000).default(200),
  // Changed conversations a single sync will carry. Past this, a cold start is cheaper.
  CHAT_SYNC_MAX_CONVERSATIONS: z.coerce.number().int().positive().default(300),

  // ---- Private calls (calls module) ----
  // How long the callee's phone rings before the call is marked MISSED. Long
  // enough to reach a phone in a pocket, short enough that a caller does not sit
  // watching a dead ring.
  CALL_RING_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(45),
  // Hard ceiling on a single call. A call still "connected" after this is a leak
  // (a client that died without hanging up), not a conversation — the reaper ends it.
  CALL_MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(14_400),
  // Grace period after ACCEPTED for media to actually connect. Past it the call is
  // FAILED: the callee said yes and then nothing happened, which is not a MISSED call.
  CALL_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  // How often the reaper sweeps for calls stranded by a worker or client crash.
  CALL_REAPER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  // Rolling rate limit on placing calls, per caller. Blunts call-spam harassment.
  CALL_RATE_MAX: z.coerce.number().int().positive().default(10),
  CALL_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // Write a CALL_LOG message into the DM thread when a call finishes.
  CALL_WRITE_CHAT_LOG: z.coerce.boolean().default(true),

  // ---- Gifts (AR-5) ----
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
