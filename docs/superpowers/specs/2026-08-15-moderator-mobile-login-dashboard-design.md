# Moderator Mobile Login & Dashboard

**Date:** 2026-08-15
**Repos touched:** `soulzaa-backend`, `soulzaa-mobile`, `soulzaa-superadmins`

## Problem

`soulzaa_mobile` (the consumer app) needs a fourth login method — username/email +
password — reached from the existing `LoginSelectionScreen` alongside phone/Google/Meta.
Unlike those, this method is gated: only accounts holding the RBAC `MODERATOR` role may
proceed past login, into a new Moderator Dashboard screen. Everyone else sees an access
denied message. Design assets (icons, dashboard mockup) are provided in
`soulzaa-mobile/assets/Moderator_UI/`.

Investigation found the backend RBAC, staff-auth, device-binding, and workforce-dashboard
plumbing already exist from prior work (see `2026-08-13-moderator-role-gap-analysis.md`).
This spec is mostly about wiring the mobile UI to that existing surface, closing one real
gap in it (unbound-device rejections vanish with no record), and closing one admin-side
gap that would otherwise make every provisioned moderator permanently unable to log in
(no UI to configure their IP allowlist).

## Existing building blocks (verified in code, not assumed)

- `POST /staff/auth/login` (`staff-auth.controller.ts` → `AuthService.staffLogin`) — validates
  credentials, checks the caller's RBAC-resolved roles against a staff role set (includes
  `MODERATOR`), verifies TOTP if enrolled, enforces single-device binding if a
  `deviceIdentifier` is sent, and checks a fixed-IP allowlist if the caller has one
  configured.
- `GET /authorization/me` (`authorization.controller.ts`) — returns
  `{ assignedRoles, inheritedRoles, resolvedPermissions, scopes }` for the current token.
  This is the RBAC source of truth; the `roles` field on the plain login response can be a
  stale legacy column and must not be used for the moderator gate (confirmed by
  `auth.service.spec.ts`'s "RBAC is the source of truth" test).
- `GET /mobile/workforce/me/dashboard` (`mobile-workforce.controller.ts` →
  `MobileWorkforceService.moderatorDashboard`) — returns shift status/countdown, scope
  (region), today's stats, warnings count, and assigned-queue counts. No backend change
  needed here.
- `ModeratorDeviceBindingService` (`moderator-device-binding.service.ts`) — single-device
  enforcement (`assertSingleDevice`) plus a two-tier device-change-request workflow
  (`requestDeviceChange` → `managerReviewDeviceChange` → `approveDeviceChange` /
  `rejectDeviceChange`), exposed at `POST/GET/PUT /moderator/device-change/*`.
- `StaffIpAllowlistService.isIpAllowed` (`staff-ip-allowlist.service.ts`) — **default-deny**:
  returns `false` when a staff user has zero configured IP/CIDR entries. Exposed at
  `POST/GET/DELETE /admin/staff/:userId/allowed-ips`, gated on `admin.identity.manage`.
- `ModeratorManagementModule.tsx` (`soulzaa-superadmins/apps/admin`) — "Provision Moderator"
  form → `POST /admin-identity/moderators` → `ModeratorProvisioningService.createModerator`,
  which assigns both the legacy roles column and the real RBAC `MODERATOR` role. Also
  usable: `POST /super-admin/users/:id/roles` to promote an existing account instead.

## Gaps this spec closes

1. **Silent device rejection.** `staffLogin`'s device-binding branch throws and forgets —
   no request is ever filed, so an admin has nothing to approve. The user's requirement
   ("rejected until admin approves") needs the rejection to *produce* a reviewable request.
2. **No IP allowlist UI anywhere.** Because the allowlist is default-deny, a moderator
   account provisioned today can never pass `staffLogin`'s IP check. There is no screen to
   fix this — only raw API calls.
3. **No device-change-request review UI anywhere.** The full review/approve/reject backend
   flow exists with no admin-facing screen.
4. No mobile screens exist yet for moderator login or the moderator dashboard.

## Design

### A. Backend — `staffLogin` device-binding branch

In `auth.service.ts`, when `deviceBinding.assertSingleDevice` throws (unbound device),
instead of only re-throwing:

1. Call `deviceBinding.requestDeviceChange({ moderatorId: user.id, newDeviceInfo: {...},
   reason: 'Automatic: rejected login from unbound device' })`.
2. If that call itself throws `ConflictException` ("already pending") — expected on repeat
   login attempts — swallow it; a request already exists, which is exactly the desired
   state.
3. Throw a new `ERROR_CODES.DEVICE_CHANGE_PENDING` (`409`), message: "This device isn't
   recognized. A request has been sent for admin approval." Added next to
   `DEVICE_NOT_FOUND`/`DEVICE_FORBIDDEN` in `error-codes.ts`.

`oldDeviceId` is omitted (moderator's prior device is looked up server-side by
`approveDeviceChange` when none is given — already handled, no change needed there).

No other `staffLogin` branch changes. 2FA and IP-allowlist branches are used as-is.

### B. Mobile — Moderator Login screen

New screen (not the existing generic `EmailLoginScreen`, which is unrelated
consumer-account email login and must not be touched), styled from the provided mockup
using `Moderator_UI` assets (`image 272` person / `image 445` lock / `image 446` eye for
field icons). Reached via a new entry point on `LoginSelectionScreen`, below the existing
phone/Google/Meta options.

Submit flow:

1. `POST /staff/auth/login` with `{ email: <identifier>, password, deviceIdentifier }`
   (identifier accepts username or email — already handled server-side by
   `findByEmail` → `findByUsername` fallback). `deviceIdentifier` comes from the existing
   `DeviceInfoService` used elsewhere in this app.
2. On `401` (invalid credentials) → inline form error, stay on screen.
3. On `401` with a 2FA-required signal → reveal an inline TOTP code field, resubmit with
   `totpCode`. (No enrollment UI — only entry, for accounts already enrolled elsewhere.)
4. On `409 DEVICE_CHANGE_PENDING` → dialog: "New device detected — a request has been sent
   to your admin for approval." Distinct copy from access-denied; not a retry-immediately
   state.
5. On `403` (not-staff-role or IP-not-allowed) → "Access Denied" alert.
6. On `200`: call `GET /authorization/me`. If `assignedRoles` does **not** include
   `MODERATOR` → log out (clear tokens/session) and show "Access Denied" — this is the
   strict, literal gate the feature requires: staff roles other than `MODERATOR`
   (`ADMIN`, `COIN_SELLER`, etc., all valid per `staffLogin`) still get denied here. If it
   does include `MODERATOR` → persist session, navigate to the Moderator Dashboard.

### C. Mobile — Moderator Dashboard screen

New screen wired to `GET /mobile/workforce/me/dashboard`, matching the provided mockup:
shift/time-left banner, assigned-region card, the 8-tile stat grid, and the performance
donut + 3-row summary. Icons from `Moderator_UI` map as: pin (region), person, document
(assigned), green check (solved), warning triangle (escalated), red alert (warnings),
gauge (performance score), hourglass (avg resolution time), teal check (task completion).
Bottom nav: Home (real), Reports/Rooms/Tasks (placeholder screens, same visual shell,
tappable — "coming soon" content).

### D. Admin panel (`soulzaa-superadmins/apps/admin`) — two small additions

Both follow the existing `ModeratorManagementModule.tsx` tab/form/table pattern and get
registered in `App.tsx` the same way (`current === '...'`).

1. **Allowed IPs** — form (userId, CIDR, label) + list + remove, wired to
   `POST/GET/DELETE /admin/staff/:userId/allowed-ips`. Without this, no provisioned
   moderator can ever pass the IP check.
2. **Device Change Requests** — list of pending requests (`GET
   /moderator/device-change/pending`) with Review / Approve / Reject actions wired to the
   existing `PUT /moderator/device-change/:id/{manager-review,approve,reject}` endpoints.
   `ADMIN` holds both review and approve permissions, so a single admin can drive a request
   through both stages from this one screen.

## Out of scope (explicit)

- Moderator self-service device-change request UI (first-login rejection now files the
  request automatically; no separate self-service path needed for this pass).
- TOTP enrollment UI (only inline code entry at login).
- Shift-schedule assignment UI (`POST /moderator/shifts/:moderatorId`) — gates in-room
  moderation actions, not login/dashboard viewing, so it doesn't block this feature.
- Reports / Rooms / Tasks real screen content (placeholders only).
- Actually provisioning `bellamkondaraviteju@gmail.com` — the user's manual action via the
  existing Provision Moderator form, since it requires a real password and a live
  admin session against the real database.

## Error handling summary (mobile-visible states)

| Backend condition | Mobile UX |
|---|---|
| Bad credentials | Inline field error |
| Not a staff role | "Access Denied" alert |
| Staff role but not `MODERATOR` (post `/authorization/me` check) | "Access Denied" alert, session cleared |
| 2FA enrolled, no/bad code | Inline TOTP entry (re-prompt on bad code) |
| Unbound device | "Request sent for admin approval" dialog (new `DEVICE_CHANGE_PENDING`) |
| No/failed IP allowlist match | "Access Denied" alert (IP-specific copy) |
| Success + `MODERATOR` confirmed | Navigate to Moderator Dashboard |

## Testing

- Backend: unit test for the new `staffLogin` device-binding branch (files a request on
  first rejection, doesn't duplicate on second, throws `DEVICE_CHANGE_PENDING`).
- Mobile: widget/controller tests for each row in the error-handling table above, plus a
  dashboard-screen test against a mocked `me/dashboard` payload.
- Admin panel: manual verification (no existing test harness precedent in this module) —
  create an IP entry, list it, remove it; approve/reject a device-change request end to
  end against a seeded pending row.
