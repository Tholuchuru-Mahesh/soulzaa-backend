# Moderator & Admin Portal — Ban, Warning & Enforcement Completion

Date: 2026-08-20
Repos touched: `soulzaa-backend`, `soulzaa-mobile` (Moderator Portal lives at `lib/features/moderator/`), `soulzaa-superadmins` (Admin Portal — `packages/shared/src/modules/ModeratorManagementModule.tsx`, reachable from `apps/admin` and `apps/superadmin`).

## Ground rule

This spec only closes gaps in features that already exist in some form. No new reason categories, no new ban systems beyond what's described, no redesign of working UI. Every section below states what already works (reuse, don't touch) before what's missing (build only that).

## Existing infrastructure (confirmed by direct code inspection)

- **`PlatformUserBan`** (`soulzaa-backend/prisma/schema/platform_moderation.prisma`, `PlatformBanService`) — the 24h, cross-room-type, account-wide ban. Fixed at `BAN_DURATION_SECONDS = 86400`. Issued today from the Moderator Portal's Room Details → per-participant → **"Ban User (24 Hours)"** (`moderator_room_details_screen.dart`) → `POST /rooms|video-rooms|live-streams/:id/moderation/platform-ban/:userId`. Already: writes the DB row + Redis TTL key, force-ends any room the target owns, disconnects sockets after a 3s delay. This is also what backs Admin Portal → Moderators → **Banned Users** (`GET /mobile/workforce/bans`, "Lift Ban" action already wired).
- **Room-wide and per-user warnings** already send correctly from the Moderator Portal (Rooms screen "Warn" button, Room Details "Warn Room" and per-participant "Warn User"). Recipient rendering is `system_warning_card.dart`, which hardcodes the sender label to the literal string `"System"`.
- **Reason vocabularies** already exist: `ReportReason` (audio) / `VideoRoomReportReason` (video) enums, including `ABUSE` and `SEXUAL_CONTENT` — these are report-reason enums but are the "currently available reasons" referred to in the brief and will be reused, not duplicated.
- **`reason (enum) + description (string)`** is an established DTO convention (see `ReportDto`) — new DTOs below follow it.
- **Generic evidence/proof upload**: `storage.controller.ts` (`POST /storage/presign`, `POST /storage/confirm`) with per-category behavior (e.g. `KYC_DOCUMENT` skips media reprocessing). Reused for Broad Ban's proof field via a new category, not a new upload mechanism.
- **Room-teardown pipeline**: `RoomEndedEvent` / `RoomClosedEvent` + `SocketManager.disconnectUserEverywhere` — already what evicts a room's occupants in real time. Reused for Broad Ban.
- **Login gate**: `auth.service.ts` `assertActive()` already blocks login for any `User.status !== 'ACTIVE'` — but `PlatformUserBan` never touches `User.status`, so a platform-banned user can log in today. This is the specific gap Item 1 closes.
- **Nothing exists** for: a room-as-entity ban, an owner-scoped "can't create" restriction, evidence/proof fields on any moderation form, "extend ban" on any ban type, an Admin Portal "Banned Broads" view, or any occurrence of the string "Soulzaa Official" anywhere in any of the three repos.

## Item 1 — Individual User Ban

**Reuse, unchanged:** the moderator-side ban action (Room Details → "Ban User (24 Hours)"), its mandatory free-text reason field, and the fixed 24h duration. No UI or duration-picker changes here.

**Missing, to build — all on the banned user's own experience, which today doesn't react to a ban at all:**
- Backend: gate login on an active `PlatformUserBan` (reuse `assertNotGloballyBanned`), returning a distinct error carrying `reason` and `expiresAt` so the client can render the specifics instead of a generic auth failure.
- Backend: confirm (or add) `reason` on the socket/event payload delivered to the banned user when the ban is issued live (`UserGloballyBannedEvent` / the emit `disconnectUserEverywhere` rides in on).
- Backend: a single fixed sender label, `"Soulzaa Official"`, attached to this ban notification payload (not a real user row — just the display string carried on the event/notification, mirroring how `"System"` is already just a client-rendered label today).
- Mobile: on receiving the ban signal (in-session) or the new login error (out-of-session), force logout (clear local session) and show a screen with sender **"Soulzaa Official"** and the selected reason. This replaces whichever generic 403/redirect-to-Home handling exists today for this case.
- Mobile: login screen surfaces the new error distinctly, blocking login while the ban is active.

## Item 2 — Broad Ban

Corrected scope (per explicit follow-up): this is **not** a reuse of the individual 24h ban aimed at the owner. It is a separate action with its own fields and its own narrower enforcement (blocks only room-creation for the owner, not login or joining).

**Hard requirement — keep these two concepts fully separate throughout implementation:** Broad Ban must NOT be implemented as "call the individual-ban logic with the owner's id." It gets its own record (see below), its own service, its own guard, and its own endpoint. `PlatformUserBan` (Item 1) and the Broad-ban record are two independent tables with independent lifecycles — a Broad ban must never write to `PlatformUserBan`, and issuing a Broad ban must never trigger Item 1's account-wide login block. The only thing the two features share on purpose is the delivery mechanism for the "Soulzaa Official" message and the general room-teardown event pipeline (`RoomEndedEvent`/`RoomClosedEvent` + socket disconnect) — not ban state, not ban records, not enforcement guards.

**Explicit runtime behavior — moderator-initiated flow:**

```
Moderator → Room Details → "Broad Ban" (reason + proof + description)
                                  ↓
                    Broad-ban record created (own table, 24h expiry)
                                  ↓
                    That specific room is force-ended now
                                  ↓
              Everyone currently inside is automatically removed
                     (RoomEndedEvent/RoomClosedEvent + socket disconnect)
                                  ↓
        Every removed user is shown the "Soulzaa Official" message,
                  containing the selected ban reason
                                  ↓
              Every removed user is routed to Home — not Login
```

**Explicit runtime behavior — Broad owner's standing while the ban is active:**

```
Broad owner, ban active:
  ❌ Cannot create a new Broad (blocked at the create call sites only)
  ✅ Can still log in normally (Item 1's login gate does not apply here)
  ✅ Can still join other Broads (no join-time check for this ban type)
```

**Reuse:**
- Reason values from `ReportReason`/`VideoRoomReportReason` (dropdown — no new categories).
- `reason` + `description` DTO shape.
- Presign/confirm upload flow for the proof field (new storage category, same pattern as `KYC_DOCUMENT`).
- `RoomEndedEvent`/`RoomClosedEvent` + socket disconnect pipeline to evict everyone from the targeted room.

**New (nothing today covers this — confirmed by direct inspection, not assumed):**
- A ban record scoped to one room + its owner: `roomId, roomType, ownerId, moderatorId, reason (enum), description, proofUrl, status, bannedAt, expiresAt (bannedAt + 24h), liftedAt, liftedBy`.
- A service method that ends that one room now and sets a Redis-backed flag scoped to **that owner's room-creation only** — distinct from `PlatformUserBan`'s account-wide flag.
- A guard checked only at the three **create** call sites (audio/video/live-stream) — not join, not login, not start.
- `POST` endpoint on the room to issue a Broad ban with `{reason, description, proofUrl}`.
- Frontend: a new, distinct **"Broad Ban"** action in Room Details (separate button from "Ban User (24h)"), with a reason dropdown, proof upload, and description field.
- Duration: fixed 24 hours, same as the individual ban (confirmed) — extendable/revocable later via Admin Portal (Item 7).
- Affected users see the Item 1 "Soulzaa Official" + reason messaging (reused, not rebuilt) and are routed to Home, not Login (fixing whatever redirect exists today for a force-ended room).

## Item 3 — Moderator Warning Sender

One-line change: `system_warning_card.dart`'s hardcoded `"System"` label becomes `"Soulzaa Official"`. No backend change — the backend never sends a display name for this message type; it's purely client-rendered.

## Item 4 — Moderator Rooms Page Cleanup

Remove the **"Warn"** and **"Join"** buttons from room cards in `moderator_rooms_screen.dart`. Room Details already has equivalent **"Warn Room"** and **"Join Live"** actions — untouched. Pure deletion, no backend change.

## Items 5 & 7 — Banned Broads (Admin Portal)

**Reuse:** same underlying ban record type and the same list/table pattern already used for Banned Users, plus the existing lift/revoke endpoint shape.

**Missing:**
- A "Banned Broads" tab/section beside "Banned Users" in `ModeratorManagementModule.tsx`, listing Broad-ban records from Item 2 (room, owner, reason, description, proof link, banned/expires timestamps, status).
- Revoke Ban action, reusing the existing lift-endpoint pattern against the Broad-ban record.
- Extend Ban action (see Item 6/7 below — shared backend piece).

## Item 6 & 7 — Extend Ban

Doesn't exist for any ban type today (only create/lift exist anywhere in the codebase, for both `PlatformUserBan` and the new Broad-ban record).

- New backend endpoint **shape** (same request/response contract, same duration-selection UI pattern), implemented as **two separate call targets** — one against `PlatformUserBan`, one against the Broad-ban record from Item 2 — never a single handler that treats both tables as the same thing. Each pushes that record's own `expiresAt` forward by an admin-selected duration and re-primes that record's own Redis TTL key.
- Admin Portal: "Extend Ban" and "Revoke Ban" both present in **both** sections, each acting only on its own record type:

```
Admin → Banned Users tab → row → Extend Ban (pick duration) / Revoke Ban
              ↓ (on extend)
    PlatformUserBan.expiresAt pushed forward
              ↓
    User receives "Soulzaa Official" message with the NEW ban duration

Admin → Banned Broads tab → row → Extend Ban (pick duration) / Revoke Ban
              ↓ (on extend)
    Broad-ban record's expiresAt pushed forward
              ↓
    Broad owner receives "Soulzaa Official" message with the NEW Broad-ban duration
```

- Both extend flows reuse Item 1's "Soulzaa Official" delivery mechanism (same label, same transport) — they do not each build their own notification path.

## Explicit non-goals

- No new report/ban reason categories beyond `ReportReason`/`VideoRoomReportReason`'s existing values.
- No duration picker on the moderator-issued individual ban or Broad ban — both stay fixed at 24h.
- No new messaging/notification system — "Soulzaa Official" is a label riding on existing ban/warning delivery paths.
- No changes to Room Details' existing Warn/Join actions, or to the participant-level "Ban User (24h)" flow, beyond what Item 1 requires for the banned user's own experience.
- No VideoRoom "ban" semantics introduced — VideoRoom explicitly has no ban feature by design outside of `PlatformUserBan`/Broad-ban, which are handled generically across room types already.
