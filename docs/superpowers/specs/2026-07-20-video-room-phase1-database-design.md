# Video Room — Phase 1: Database Design & Core Domain Model (VR-1)

Status: **Approved** (design decisions locked 2026-07-20)
Builds on: VR-0 foundation (`2026-07-20-video-room-phase0-design.md`)
Owner module: `src/modules/video-rooms`

---

## 1. Scope

Phase 1 designs and implements the **complete Video Room database domain** and its
persistence/mapping layer — nothing more. It is the durable system-of-record that
every later phase (lifecycle, seats, viewer mode, PK, chat, gifts, moderation)
reads and writes.

**In scope:** Prisma schema (extend VR-0 + new tables), additive offline migration,
enums, constants, code permission matrix, repositories (persistence primitives),
DTOs, entity views + mappers, reference-data seeders, documentation, and
repository/constraint tests.

**Explicitly NOT in scope** (deferred to later phases): room create/join/leave,
seat/camera/mic logic, streaming, chat, gifts, treasure, PK, wallet, notifications,
analytics *processing*, socket business logic, any orchestration or business rule.
Repositories are pure persistence; services that call them for workflows land with
their phases. **`VideoRoomBan` is excluded** per product instruction (mute + block
cover the moderation need for this phase).

## 2. Locked design decisions

Resolved with the product owner because the brief's top-level "enterprise checklist"
(version + status + `deletedBy` + FK cascade rules on *every* table; ~30 separate
tables) contradicts the platform conventions the same brief later mandates (reuse,
don't duplicate, extend). VR-0 already committed to conventions. The rulings:

1. **Conventions win.** Match VR-0 / Audio-Room exactly:
   - `deletedAt`-only soft delete (no `deletedBy`; there is one such column
     platform-wide, on audio chat — not a general rule).
   - **No optimistic-lock `version` column.** State machines use conditional
     updates. (`version` appears once platform-wide: the wallet money row.) The one
     `version Int` we do add is `VideoRoomSnapshot.version` — a state *sequence
     number*, matching VR-0's versioned Redis state, not a lock.
   - **No cross-domain foreign keys.** All references are by id + `@@index`,
     application-enforced — deliberate for horizontal scaling / microservice split.
     No `@relation` in the room domains. Reference data (`room_categories`,
     `room_languages`) is referenced **by value**.
   - Append-only tables (logs, events, moderation actions) carry only
     `id / keys / action|type / metadata / createdAt` — no `updatedAt`/`deletedAt`/audit.
   - `status` is domain-specific, not a universal column.
2. **Reuse-maximal.** New tables only for genuine video-specific gaps. Analytics →
   shared `analytics` module (`RoomActivity` / `RoomDailyStat` / `CreatorDailyStat`
   / `RevenueReport`, keyed by generic `roomId`). Categories/languages → shared
   reference by value. Permissions → code. Tags → Postgres `String[]` array column.
3. **Permissions = code matrix + grants table.** `VideoRoomPermission` enum +
   `VIDEO_ROOM_PERMISSION_MATRIX` in code (single source of truth, unit-testable, no
   migration to change policy) — mirrors Audio Rooms' `RoomPermission`. Per-room
   elevated grants (ADMIN / MODERATOR) persist in `video_room_roles`.

## 3. The 30-model mapping

Legend: 🔵 EXTEND VR-0 · 🟣 NEW · 🟢 REUSE · ⛔ EXCLUDED

| Checklist model | Disposition | Where |
|---|---|---|
| VideoRoom | 🔵 | + country, region, roomLevel, themeId, backgroundId, `tags String[]`, streamingStatus, isVerified, creationSource, metadata |
| VideoRoomMember | 🔵 | + memberStatus, joinSource, platform, country, region, deviceId, lastActiveAt |
| VideoRoomParticipant | 🟢 | Member(role∈{OWNER,HOST,PARTICIPANT}) + Seat occupancy + Session |
| VideoRoomViewer | 🟢 | `VideoRoomPresence` (live/heartbeat) + analytics `RoomVisitor` (watch duration) |
| VideoRoomSeat | 🟣 | `video_room_seats` (mirrors `RoomSeat`) |
| VideoRoomSeatRequest | 🟣 | `video_room_seat_requests` |
| VideoRoomInvitation | 🟣 | `video_room_invitations` (seat + room invite via type) |
| VideoRoomAdmin | 🟢 | `video_room_roles` grant (role=ADMIN) |
| VideoRoomModerator | 🟢 | `video_room_roles` grant (role=MODERATOR) |
| VideoRoomBan | ⛔ | excluded |
| VideoRoomMute | 🟣 | `video_room_mutes` (mirrors `RoomMute`) |
| VideoRoomBlock | 🟣 | `video_room_blocks` (room blocklist; bar-until-lifted, no expiry) |
| VideoRoomAnnouncement | 🟣 | `video_room_announcements` (editable → full audit + deletedAt) |
| VideoRoomTheme | 🟣 | `video_room_themes` (seeded reference) |
| VideoRoomBackground | 🟣 | `video_room_backgrounds` (seeded reference) |
| VideoRoomSettings | 🔵 | + full flag set (viewer chat, pk, recording, beauty, camera switch, screen share, join request, share, invite, follow, reporting, treasure, announcements, maxDurationMinutes, slowModeSeconds, seat layout) |
| VideoRoomMetadata | 🟢 | `metadata Json?` on VideoRoom + Settings |
| VideoRoomStatistics | 🔵 | + avgWatchTimeSeconds, totalGifts, totalGiftCoins, totalPkCount, totalChatMessages, totalSessions |
| VideoRoomAnalytics | 🟢 | shared analytics module (by roomId) |
| VideoRoomEvent | 🟣 | `video_room_events` (generic event store: eventType, payload, correlationId) |
| VideoRoomLog | 🔵 | VR-0 lifecycle audit; extend action enum |
| VideoRoomSnapshot | 🟣 | `video_room_snapshots` (serialized state + version + reason) |
| VideoRoomConnection | 🟢 | Redis `ConnectionStatus` (ephemeral) + `VideoRoomSession` summary |
| VideoRoomDevice | 🟢 | deviceId/platform on Session + Member; shared `device` module |
| VideoRoomSession | 🟣 | `video_room_sessions` (durable media session, mirrors `VoiceSession`) |
| VideoRoomPresence | 🟢 | VR-0 mirror, unchanged (lastSeenAt = heartbeat) |
| VideoRoomPermission | 🟢 | code enum + matrix |
| VideoRoomRole | 🟣 | `video_room_roles` grants (mirrors `RoomRole`) |
| VideoRoomLanguage | 🟢 | shared `room_languages` (by value) |
| VideoRoomCategory | 🟢 | shared `room_categories` (by value) |
| VideoRoomTag | 🟢 | `tags String[]` GIN-indexed column |
| (audit) VideoRoomModerationAction | 🟣 | `video_room_moderation_actions` (append-only) |

**Net: 13 new tables, 6 extensions, 11 reuse/excluded.**

## 4. Schema layout (files)

Split by concern, mirroring `audio_rooms*.prisma` ownership:

- `video_rooms.prisma` — 🔵 EXTEND core: VideoRoom, VideoRoomSettings,
  VideoRoomMember, VideoRoomStatistics, VideoRoomPresence, VideoRoomLog + enums.
- `video_rooms_seats.prisma` — 🟣 VideoRoomRole, VideoRoomSeat, VideoRoomSeatRequest,
  VideoRoomInvitation + seat enums.
- `video_rooms_moderation.prisma` — 🟣 VideoRoomMute, VideoRoomBlock,
  VideoRoomModerationAction + moderation enums.
- `video_rooms_media.prisma` — 🟣 VideoRoomSession + media enums.
- `video_rooms_events.prisma` — 🟣 VideoRoomEvent, VideoRoomSnapshot,
  VideoRoomAnnouncement + snapshot enum.
- `video_rooms_reference.prisma` — 🟣 VideoRoomTheme, VideoRoomBackground.

## 5. Enums

New Prisma (DB) enums:
- `VideoRoomStreamingStatus` = IDLE | PUBLISHING | PAUSED
- `VideoRoomCreationSource` = APP | WEB | API | SYSTEM
- `VideoRoomMemberStatus` = ACTIVE | INACTIVE | LEFT | REMOVED
- `VideoRoomSeatType` = OWNER | HOST | GUEST
- `VideoRoomSeatStatus` = EMPTY | OCCUPIED | LOCKED | RESERVED
- `VideoRoomSeatRequestType` = TAKE_SEAT
- `VideoRoomSeatRequestStatus` = PENDING | ACCEPTED | REJECTED | CANCELLED | EXPIRED
- `VideoRoomInvitationType` = SEAT | ROOM
- `VideoRoomInvitationStatus` = PENDING | ACCEPTED | REJECTED | EXPIRED | CANCELLED
- `VideoRoomModerationMuteType` = TEMPORARY | PERMANENT
- `VideoRoomModerationStatus` = ACTIVE | LIFTED | EXPIRED
- `VideoRoomModerationActionType` = MUTE_TEMPORARY | MUTE_PERMANENT | UNMUTE | BLOCK |
  UNBLOCK | KICK | WARN | ROLE_GRANTED | ROLE_REVOKED | ANNOUNCEMENT_POSTED |
  ANNOUNCEMENT_REMOVED
- `VideoRoomPublishRole` = PUBLISHER | SUBSCRIBER
- `VideoRoomSessionStatus` = ACTIVE | ENDED
- `VideoRoomSnapshotReason` = PERIODIC | PRE_SHUTDOWN | MANUAL | RECOVERY

Extended: `VideoRoomMemberRole` += ADMIN, MODERATOR (elevated grants).
`VideoRoomLogAction` += SETTINGS_CHANGED, ROLE_CHANGED, THEME_CHANGED,
ANNOUNCEMENT_POSTED, INVITED, REQUEST_ACCEPTED, REQUEST_REJECTED, SEAT_TAKEN,
SEAT_LEFT, MUTED, UNMUTED, BLOCKED, UNBLOCKED, KICKED.

Runtime (code-only, unchanged from VR-0, in `enums/index.ts`): ConnectionStatus,
ConnectionType, SessionStatus, ParticipantStatus, ViewerStatus, StreamStatus,
MediaProviderKind. New code enum: **`VideoRoomPermission`** (+ matrix), in
`constants/video-room-permissions.ts`.

## 6. Indexing (per brief)

VideoRoom: `status`, `ownerId`, `categoryId`, `language`, `country`,
`(visibility,isDiscoverable,status)` (VR-0), `(status,visibility)`,
`(country,categoryId)`, `createdAt`, GIN on `tags`. Member: `(roomId,userId)` unique,
`roomId`, `userId`, `(roomId,role)`. Seat: `(roomId,seatIndex)` unique,
`(roomId,occupantUserId)` unique, `roomId`. SeatRequest: `(roomId,status)`, `userId`.
Invitation: `(roomId,status)`, `(inviteeUserId,status)`. Role: `(roomId,userId)`
unique, `roomId`. Mute/Block: `(roomId,status)`, `(userId,status)`,
Mute + `(status,expiresAt)`. ModerationAction: `roomId`, `action`, `targetUserId`.
Session: `(roomId,userId)` unique, `roomId`, `status`. Event: `roomId`, `eventType`,
`correlationId`. Snapshot: `(roomId,createdAt)`. Announcement: `roomId`.
Reference: `slug` unique.

## 7. Constraints

Unique: `video_rooms.zegoRoomId`; `(roomId,userId)` on members / roles / sessions /
presence; `(roomId,seatIndex)` and `(roomId,occupantUserId)` on seats; `slug` on
theme/background. "One ACTIVE mute/block per (room,user)" and "one PENDING
request/invitation per user" are service-enforced under a lock (matches Audio
Rooms — partial-unique on an enum isn't expressed in Prisma). No DB FKs by
convention; orphan-avoidance is application-level + soft delete.

## 8. Module layer

- **Enums (code):** add `VideoRoomPermission` + `VIDEO_ROOM_PERMISSION_MATRIX`
  (`constants/video-room-permissions.ts`) — OWNER=all; ADMIN/MODERATOR=moderation
  subset; HOST/PARTICIPANT/VIEWER=none. Helpers `isElevatedRole`,
  `roleHasPermission`.
- **Constants:** extend `video-room.constants.ts` with seat-layout defaults,
  moderation/request TTL bounds, reference-data seed lists (themes/backgrounds).
- **Repositories** (pure persistence, grouped like Audio Rooms):
  `VideoRoomSeatsRepository` (seats + requests + invitations),
  `VideoRoomRolesRepository`, `VideoRoomModerationRepository` (mutes + blocks +
  actions), `VideoRoomMediaSessionRepository`, `VideoRoomEventsRepository` (events +
  snapshots + announcements), `VideoRoomReferenceRepository` (themes + backgrounds).
  Extend `VideoRoomsRepository` with the new column reads. All use
  `auditCreate/auditUpdate/auditSoftDelete`; no Prisma outside repositories.
- **Entity views + mappers** (`entities/` + `mappers/`): client-safe projections for
  seat, role, invitation, announcement, theme, background (drop audit/internal cols).
- **DTOs** (`dto/`): create/update/list/filter bodies for the new sub-domains
  (seat-request, invitation, role-grant, moderation, announcement, reference filter,
  pagination) — validated + Swagger-documented, contract-only (endpoints stay 501).
- **Seeder:** `VideoRoomReferenceSeederService` seeds default themes/backgrounds
  idempotently (mirrors `room-reference-seeder.service.ts`).
- **Module wiring:** register new repositories + seeder in `video-rooms.module.ts`;
  update barrels.

## 9. Migration strategy

One additive migration `20260720130000_video_rooms_phase1_domain/migration.sql`,
hand-authored in the platform style (generated offline via `prisma migrate diff
--from-schema-datamodel <snapshot> --to-schema-datamodel prisma/schema --script`;
**not applied**). It:
- `CREATE TYPE` for the new enums; `ALTER TYPE ... ADD VALUE` for
  `VideoRoomMemberRole` / `VideoRoomLogAction` extensions.
- `ALTER TABLE ... ADD COLUMN` (all nullable or defaulted → backward compatible) for
  VideoRoom / Settings / Member / Statistics.
- `CREATE TABLE` + `CREATE INDEX` for the 13 new tables.
No `DROP`/destructive statements; rollback = drop new tables/columns/types.

## 10. Testing

- Repository unit tests (mock Prisma) for each new repository: create/read/update,
  audit stamping, soft-delete/restore where applicable, upsert idempotency.
- Constraint/relationship tests: unique (room,user); seat uniqueness; append-only
  invariants (no update path on logs/events/actions); reference slug uniqueness;
  by-id reference integrity (no cross-table FK — assert reads tolerate missing refs).
- Permission-matrix unit tests: OWNER⊇ADMIN⊇∅; `roleHasPermission` correctness.
- Keep the existing 806 tests green (purely additive).

## 11. Documentation

- Update `src/modules/video-rooms/README.md` (owned-tables list, new sub-domains).
- Entity/relationship notes: an ERD-style relationship description in this spec's
  appendix + doc comments on every model (the schema is self-documenting via `///`).

## 12. Implementation order

1. Schema files (all tables/enums) → `prisma format` + `validate`.
2. Migration SQL.
3. Code enums + permission matrix + constants.
4. Repositories + views + mappers + DTOs + seeder.
5. Module wiring + barrels.
6. Tests.
7. `tsc` + lint + full suite green.
8. README/docs.
