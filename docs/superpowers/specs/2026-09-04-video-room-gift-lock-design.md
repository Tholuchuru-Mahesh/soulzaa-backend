# Video Room Gift-Lock — Design Spec

Date: 2026-09-04
Repos affected: `soulzaa-backend`, `soulzaa-mobile`
Repos explicitly NOT affected: `soulzaa-superadmins` (reads existing config only), audio rooms in either repo

## 1. Goal

Replace video rooms' existing password-based "Lock Room" feature with a gift-based one: the host designates a single gift from the existing gift catalog as the room's "entry gift." Any viewer (non-seat-holder) who is not already a member must send that exact gift to the host before they can join or continue watching. All wallet deduction and creator-earnings math must go through the existing, canonical gift pipeline — no parallel coin-charge logic (the video-room "paid entry fee" feature is the cautionary example of what NOT to replicate: it silently forked its own earnings percentage instead of reusing the gift pipeline's).

## 2. Non-goals / explicit exclusions

- **Audio rooms** have their own, entirely separate `isLocked`/password-lock implementation (separate Prisma model and service files, e.g. `audio-rooms.service.ts`). Not touched in any way.
- **Per-seat locking** (`VideoRoomSeat.isLocked`, `lockSeat()` in both the backend seat service and `video_room_repository_impl.dart:489`) is an unrelated feature (host locking/unlocking individual speaker seats) and is not touched.
- **Paid-entry-fee feature** (`VideoRoomEntryPaymentService`, `VideoRoomEntryAccess`) is a separate, pre-existing mechanism with its own earnings config (`VIDEO_ROOM_ENTRY_CREATOR_PERCENTAGE`). It is not modified, removed, or merged with gift-lock. A room may have both gift-lock and paid-entry enabled simultaneously; a viewer must independently satisfy whichever gates are active.
- `join_password_dialog.dart` (mobile) is shared with audio rooms and generic join flows. It is not deleted — only its call site inside the video-room join-error handler is removed.

## 3. Removal: existing video-room password lock

**Backend** (`soulzaa-backend`):
- Drop `VideoRoom.isLocked`, `VideoRoom.passwordHash` columns (migration).
- Delete `VideoRoomPasswordService` (`src/modules/video-rooms/services/video-room-password.service.ts`) — used exclusively by room-lock, safe to remove outright.
- Remove `VideoRoomLifecycleService.lock()` / `.unlock()` / `computeLockPatch()` and the `LockVideoRoomDto`.
- Remove `POST /video-rooms/:id/lock`, `POST /video-rooms/:id/unlock` from `video-rooms.controller.ts`.
- Remove the admin override (`POST /admin/video-rooms/:id/lock`, `LockRoomAdminDto`, `VideoRoomsAdminService.setLock()`).
- Remove `RoomLockedEvent`/`RoomUnlockedEvent`, their bus constants, and the relay branch in `video-room-socket.listener.ts`; remove `video_room.locked` from `videoRoomSocketEventNames` (mobile).
- Remove the password gate block in `VideoRoomMemberService.join()` (member-service.ts:161-175) and the `password` field from the join DTO.
- Update `VideoRoomLifecycleState`/`VideoRoomAccessPolicy` derivation (`constants/video-room-lifecycle.ts`) to stop deriving `LOCKED`/`PASSWORD` from the removed fields (re-derive `LOCKED` from the new `giftLockEnabled` instead, per §4).
- Sweep the ~47 files that reference `isLocked`/`passwordHash` (mappers, views, DTOs, repository selects, tests) to remove the field from serialized output and update/delete tests accordingly. This is mechanical (type-checker-driven) rather than a design decision — enumerated during implementation, not here.
- Remove `VideoRoomLogAction.LOCKED`/`UNLOCKED` usages tied to the password flow (replaced by new gift-lock log actions, §4).

**Mobile** (`soulzaa-mobile`):
- Remove the Lock Room toggle + "Change Password" nav tile from `privacy_access_page.dart` (replaced per §6).
- Remove `VideoRoomController.setRoomLocked()`.
- Remove `lockRoom()`/`unlockRoom()` from `video_room_repository_impl.dart:697-710`, and the `password` parameter from `getRoomById`/join calls (`:141-165`).
- Remove the password-prompt branch in `video_room_live_screen.dart` (`ref.listen` block at ~410-418, `_handlePasswordPrompt` at ~317) — i.e. stop calling `showJoinPasswordDialog` from video rooms. Do not touch `join_password_dialog.dart` itself or its other five call sites.
- Remove `VideoRoomPermission.lockRoom` usages tied to the deleted UI (the permission constant itself is reused, see §4).

## 4. New feature: data model

`prisma/schema/video_rooms.prisma`:
```prisma
model VideoRoom {
  // ...existing fields...
  giftLockEnabled    Boolean  @default(false)
  requiredEntryGiftId String? @db.Uuid
  requiredEntryGift   Gift?   @relation(fields: [requiredEntryGiftId], references: [id])
}
```

New file `prisma/schema/video_rooms_gift_lock_access.prisma`:
```prisma
/// Session-scoped Gift-Lock entry entitlement, mirroring VideoRoomEntryAccess's
/// shape for paid entry. A successful send of the room's required entry gift
/// grants access to the CURRENT broadcast session only.
model VideoRoomGiftLockAccess {
  id                String   @id @default(uuid()) @db.Uuid
  userId            String   @db.Uuid
  roomId            String   @db.Uuid
  sessionId         String   @db.Uuid
  giftId            String   @db.Uuid
  giftTransactionId String   @db.Uuid
  grantedAt         DateTime @default(now())
  createdAt         DateTime @default(now())

  room    VideoRoom             @relation(fields: [roomId], references: [id], onDelete: Cascade)
  session VideoBroadcastSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@unique([userId, sessionId])
  @@index([roomId, sessionId])
  @@map("video_room_gift_lock_accesses")
}
```

Access is **session-scoped**, matching paid-entry's existing behavior: when the broadcast session ends and a new one starts, prior grants don't carry over and the host's current required-gift setting (if still enabled) applies fresh.

`VideoRoomLifecycleState.LOCKED` and `VideoRoomAccessPolicy` (`constants/video-room-lifecycle.ts`) now derive from `giftLockEnabled` instead of the removed `isLocked`.

`VideoRoomLogAction` gains `GIFT_LOCK_ENABLED`/`GIFT_LOCK_DISABLED` (replacing `LOCKED`/`UNLOCKED`).

## 5. Backend service & API

New `VideoRoomGiftLockService` (fresh code — does not extend or call anything from the deleted lock service):
```ts
async enable(actor: RoomActor, roomId: string, giftId: string): Promise<VideoRoomDetailView>
async disable(actor: RoomActor, roomId: string): Promise<VideoRoomDetailView>
```
- Owner-only, gated by the existing `VideoRoomPermission.LOCK_ROOM` constant (reused as an authorization concept — "who may lock this room" is unchanged; no lock *logic* is reused).
- `enable()` validates `giftId` exists and is an active catalog gift (`IGiftsService.isGiftEnabled`) before persisting.
- Publishes `GiftLockEnabledEvent { roomId, gift }` / `GiftLockDisabledEvent { roomId }` on the bus; a new `video-room-gift-lock-socket.listener.ts` (following the existing per-sub-domain listener pattern) relays to socket events (§7).
- Endpoints: `POST /video-rooms/:id/gift-lock { giftId }`, `POST /video-rooms/:id/gift-lock/disable`.

**Grant hook** — `VideoRoomGiftContextHandler.onSend()` (`src/modules/video-rooms/services/video-room-gift-context.handler.ts`), inside the same Prisma transaction `GiftService.sendGiftBatch()` already runs:
```
if (room.giftLockEnabled
    && tx.giftId === room.requiredEntryGiftId
    && receiverId === room.ownerId  // or current hostId
    && activeSession exists) {
  upsert VideoRoomGiftLockAccess { userId: senderId, roomId, sessionId: activeSession.id, giftId, giftTransactionId }
}
```
This is the **only** integration point into the gift pipeline. No changes to `GiftService`, `WalletService`, or `settlementRules()` — wallet deduction and creator-earnings conversion happen exactly as they do for any gift sent to the host today, because this literally is a normal gift send.

**Join gate** — one additional step in `VideoRoomMemberService.join()`, same shape/position as the existing paid-entry check (immediately after it):
```ts
if (room.giftLockEnabled && !privileged && effectiveRole === 'VIEWER') {
  const hasAccess = await this.giftLockAccessRepo.hasGrantedAccess(actor.id, activeSession.id);
  if (!hasAccess) {
    throw this.err(ERROR_CODES.VIDEO_ROOM_GIFT_REQUIRED, ..., HttpStatus.PAYMENT_REQUIRED)
      // payload includes { gift: { id, name, iconUrl, priceCoins } } so the client
      // can render the dialog without a second fetch
  }
}
```
`OWNER`/`HOST`/`PARTICIPANT` (any seat-holder, resolved the same way the existing role-resolution already works) bypass unconditionally — this is what "don't gate host speakers" maps to structurally.

## 6. Realtime / socket events

New bus events → new client-facing socket events (added to `VIDEO_ROOM_SOCKET_EVENTS` and mobile's `videoRoomSocketEventNames` allow-list):
- `video_room.gift_lock_enabled` — payload `{ roomId, gift }`. Broadcast to the whole room so every connected client (not just new joiners) reacts immediately.
- `video_room.gift_lock_disabled` — payload `{ roomId }`.
- `video_room.gift_lock_granted` — payload `{ roomId, userId }`, emitted after a successful grant (from `afterCommit` on the gift context handler), used only to update the *sender's own* client state optimistically (everyone else doesn't need to know who else has paid).

Mobile `VideoRoomController._initSocketSubscription()` gains three new `case` branches updating `VideoRoomState` (`giftLockEnabled`, `requiredEntryGift`, and locally-tracked `hasGiftLockAccess`).

## 7. Mobile UI

**Host enabling the lock** (`privacy_access_page.dart`): "Require Gift to Enter" `SettingsToggleTile`, following the exact same optimistic-toggle/pending/rollback pattern the old lock toggle used. Turning it on calls `showGiftPanelSheet(..., pickOnly: true)` — a new mode added to the shared gift panel:
- `showGiftPanelSheet` gains an optional `bool pickOnly = false` parameter.
- When `true`, `_GiftPanelSheet` swaps the footer's `GiftComboSendBar` for a simple "Set as Entry Gift" button, disables recipient/quantity selection (single gift, quantity fixed at 1, since this is a selection not a send), and on tap calls `Navigator.pop(context, selectedGift)` instead of sending anything.
- The settings page awaits that popped `Gift?`; a non-null result calls the new `VideoRoomController.enableGiftLock(gift)` (calls `POST /gift-lock`); `null` (user cancelled) reverts the toggle.

**Non-member trying to join a gift-locked room**: `VideoRoomController.joinRoom()` catches `VIDEO_ROOM_GIFT_REQUIRED` (parallel to how it catches the old password error today) and shows a new non-dismissible-by-back, cancellable-by-button dialog (`GiftRequiredDialog`, new widget) stating the required gift (name + icon from the error payload). "Send Gift" opens `showGiftPanelSheet` in **normal send mode**, pre-selected to that exact gift, receiver pre-locked to the host, quantity 1 (send mode already supports pre-selecting a gift/receiver per its existing constructor params). On successful send (`GiftSendOutcome.isSuccess`), the panel closes and `joinRoom()` is retried automatically. Cancelling leaves the room screen (same as declining the old password dialog).

**Already inside when the host enables the lock**: on receiving `video_room.gift_lock_enabled`, the controller checks the local effective role. If `VIEWER` (not on a seat) and `hasGiftLockAccess` is not already true, show a blocking modal (`PopScope(canPop: false)` + `barrierDismissible: false`, following the `SessionDialogs` precedent) with the same "send this gift to continue watching" content and a "Send Gift" button — same send-mode gift-panel flow as above. `HOST`/`PARTICIPANT` never see this. On `video_room.gift_lock_disabled`, any such open dialog is auto-dismissed for whoever is still waiting.

**Lifecycle / reconnect**: `VideoRoomController` has no app-resume observer today (heartbeat-driven reconnect only, per its own code comment). Extend `_recoverSession()` (called on a failed heartbeat / on `_tryRejoin()`) to re-fetch gift-lock state and access status as part of the existing rejoin payload, so a backgrounded-then-resumed viewer who was blocked stays blocked (or, if they sent the gift from another device in the meantime, becomes unblocked) without needing a new lifecycle hook. This reuses the existing reconnect mechanism rather than adding a new one.

## 8. Edge cases

- **Host disables lock while someone is mid-send**: the gift send still completes normally (it's an unconditional gift transaction); the grant hook simply becomes a no-op if `giftLockEnabled` is now false by the time `onSend()` runs — no error, the sender just also receives the normal gift-send outcome.
- **Host changes the required gift while people are blocked**: treated as disable+enable — a new `video_room.gift_lock_enabled` event fires with the new gift; anyone who'd already sent the *old* required gift this session keeps their granted access (access is keyed by session, not by which gift was required at grant time) — *this favors not re-charging users who already paid over strict enforcement of "this exact gift, right now."* Flag if you want re-gating on gift change instead.
- **Room's broadcast session ends and restarts** (host goes offline and live again): access resets, consistent with paid-entry's existing behavior — returning viewers must send the gift again if the lock is still enabled.
- **Room owner sends themselves the required gift**: not possible — `GiftService` already rejects self-gifting; irrelevant here since owner bypasses the gate entirely.
- **Moderators/admins joining incognito**: bypass unconditionally, same as they already bypass password-lock and paid-entry today (existing `isModerator`/`privileged` branches in `join()`, untouched).
- **Required gift gets deleted/disabled from the catalog while lock is active**: `enable()` validates the gift is active at set-time; if it's later disabled, existing lock stays active with a now-unobtainable gift — surfaced as a data-integrity edge case for the implementation plan to decide (likely: gift-catalog deletion should force-disable any room's `giftLockEnabled` referencing it, mirroring how other FK-adjacent soft-deletes are handled elsewhere in the codebase).

## 9. What's explicitly reused, unchanged

- `GiftService.sendGiftBatch()`, `settlementRules()`, `gift.receiver_earnings_percentage` config — zero changes.
- `WalletService.debit()`/`credit()` — zero changes.
- `showGiftPanelSheet`'s existing send-mode internals (`GiftCard`, `GiftComboSendBar`, `GiftController.send()`) — zero changes, only a new opt-in `pickOnly` mode added alongside.
- `SocketManager`, the bus→listener→namespace-room relay pattern — new events follow the existing pattern exactly, no infra changes.
- `SessionDialogs`' non-dismissible modal pattern — visual/structural precedent reused for the new blocking dialog, not the code itself (different domain).
