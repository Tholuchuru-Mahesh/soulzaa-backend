# Enterprise Admin Role — Master Roadmap

**Status:** Roadmap. Phase 1 is detailed in `2026-08-02-admin-identity-phase-1.md`; later phases get their own detailed plan when the preceding phase lands.

**Goal:** Deliver the complete Soulzaaa Enterprise Admin Role across `soulzaa-backend` and `soulzaa-admin-web`, orchestrating the 21 frozen business engines without duplicating their logic.

---

## Where we actually are

Measured on 2026-08-02, not estimated.

| | Backend | Admin Web |
|---|---|---|
| Modules | ~50 | 5 |
| Controllers / files | 107 controllers, **1,044 routes** | 19 source files |
| Tests | **422 spec files** | 0 |
| Write operations exposed | extensive | **6** (29 GET vs 6 POST/PUT) |

**The backend is mature; the console is a read-only dashboard.** Roughly 60% of the spec's required *Actions* already have a working, RBAC-guarded, audited API route with no button anywhere in the UI. That imbalance sets the phase ordering: the cheapest large wins are UI wiring, and the genuinely missing work is concentrated in Admin identity, admin login hardening, and creator management.

### Verified-absent features

These were confirmed missing by exhaustive grep, not assumed:

- **Admin invisibility** — no `isHidden`, `hiddenFrom`, `stealth`, `excludeAdmin`, or equivalent anywhere. Admins currently appear in search, rankings, followers, room member lists, and viewer lists exactly like ordinary users.
- **Invisible Join** — the only `invisible` matches in the repo are two unrelated code comments.
- **2FA / TOTP on login** — no `speakeasy`, `otplib`, or `authenticator` dependency in `package.json`. The `otp` module is mobile/email *verification*, not login second-factor.
- **Creator/Host management module** — no `creator` or `host` module exists.
- **Wallet freeze/unfreeze routes** — `admin/wallet` has `adjust` and `recovery`; `super-admin/wallets` has `credit`/`debit`/`transfer`. No freeze.

---

## Global Constraints

Every phase inherits these. They are enforced by tooling, not convention — violating them fails CI.

- **No cross-module imports.** `.dependency-cruiser.cjs` rule `no-cross-module-imports` is `severity: 'error'`: *"Access another domain module only through its public `interfaces/` (service contract + DI token) or published `events/`, or via the EVENT_BUS (`src/common/events`) — never its entities/repositories/services/controllers."* Verify with `pnpm boundaries`.
- **No direct Prisma mutations from admin code.** Route every write through the owning module's service.
- **Every financial action** uses the existing wallet service and `AuditLogService`. Never re-implement ledger logic.
- **Administrative controllers must be named `*-admin.controller.ts`** or live under `src/modules/super-admin/`. `rbac-role-matrix.spec.ts` discovers administrative controllers by exactly that convention and asserts every `RequirePermissions` code on them sits in the correct role bucket. A new admin controller named anything else silently escapes the authority-matrix test.
- **`SUPER_ADMIN_ONLY` permissions must never be granted to `ADMIN`** — enforced by `rbac-role-matrix.spec.ts`. Current list: `config.settings.update`, `config.settings.reset`, `config.flags.manage`, `treasury.policies.update`, `treasury.risk.manage`, `revenue.configuration.manage`, `coin.manage`.
- **`User.roles` (the `PlatformRole[]` column) is legacy and being retired.** Guards read only the `UserRole` table. Never gate new behaviour on the enum column.
- **Console entry** requires a `dashboard.*` permission — `AuthProvider.hasConsoleAccess` in the admin web. New nav items need a matching permission code.
- Backend commands: `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm boundaries`, `pnpm build`.

---

## Phases

Sections 22 (Security), 23 (Swagger) and 24 (Testing) are **not phases**. They are acceptance criteria applied to every task in every phase: RBAC guard + audit log + Swagger decorators + tests, or the task is not done.

### Phase 1 — Admin Identity, Invisibility & Admin Login
**Spec sections 1, 2 · Detailed plan written · Largest true gap**

Establishes the hidden Admin account and hardens the admin login path. Everything else assumes an Admin exists and can be told apart from a user, so this goes first.

Architecture decision (settled): a denormalised `User.isHiddenAccount` boolean, written by exactly one owner (the new `admin-identity` module) on role grant/revoke plus a one-off backfill, and filtered at three chokepoints:

1. `ProfileService.search()` — already has an `excludeIds` seam used for blocked users; hidden ids join it.
2. `ProfileService.getCards()` — documented as *"the only sanctioned cross-module read of user/profile data"* and consumed by **9 modules** (audio-rooms, calls, casino, chat, games, notification, social, users, video-rooms). One filter here covers followers, friends, room members, live viewers, mentions and audience lists at once.
3. Rankings — bypasses `getCards`, so it needs a write-side guard that never enrols a hidden account into a leaderboard.

A denormalised column is used rather than a role lookup because the `users` module may not import the `authorization` module's services (boundary rule), and because it costs zero extra queries on every card resolve.

**Delivers:** hidden admin accounts, admin provisioning restricted to Super Admin, Super Admin non-identifiability, login telemetry (browser/OS/country), TOTP 2FA, device and IP verification.

---

### Phase 2 — Console Foundation & User Management UI
**Spec sections 4, 5 · Highest value per hour**

The backend already ships `super-admin/users` with `:id/status/suspend`, `activate`, `reactivate`, `lock`, `unlock`, `:id/force-logout`, `:id/roles`, `:id/promote`, `:id/demote`, `:id/audit-logs`. None are reachable from the UI.

- Rebuild the sidebar to the 24 required entries, permission-gated per item.
- Replace the read-only `UsersScreen` with a real management page: the full search filter set (User ID, Custom ID, Username, Mobile, Email, Country, Region, Language, VIP, Level, Status, Registration Date, Last Login) and the action set (Suspend, Restore, Freeze Wallet, Unfreeze Wallet, Force Logout, Reset Password, Reset Device, View Audit).
- Add the per-user detail tabs: Wallet, Transactions, Games, Rooms, Streams, Reports, Warnings, Family, Agency, Creator.
- Establish the reusable management-page pattern (filter bar → `DataTable` → row actions → confirm → audit toast) that Phases 3–7 copy.

**Backend work needed:** wallet freeze/unfreeze routes, reset-password and reset-device admin routes, a user list endpoint accepting the full filter set.

---

### Phase 3 — Staff & Partner Management
**Spec sections 6, 7, 8, 9, 10, 11, 12**

- **Creator Management (§6) is a new module** — no creator/host module exists. Needs the Audio/Video/Artist/Singer/Gaming/Influencer/Verified taxonomy, plus Analytics, Revenue, Followers, Hours, Violations, Approve, Reject, Assign Agency, Suspend, Restore.
- **Manager / Official / Moderator / BD (§7–10)** currently share one `super-admin/workforce` controller with 9 routes (`personnel`, `personnel/:id`, `workload`, `status`, `hierarchy`, `assign`, `transfer`, `reassign`). Extend to per-role Create/Approve/Suspend/Restore/Reset Password/Assign Region/Responsibilities/Performance/Logs, then build four management screens.
- **Agency (§11) and Coin Seller (§12)** have settlement engines and `agency.approve`/`seller.approve` permissions defined, but no approve/reject routes wired to a review queue. Add those plus the UI.

---

### Phase 4 — Operational Dashboard
**Spec section 3**

Four read-model controllers exist (`dashboard/operations`, `dashboard/financial`, `dashboard/moderation`, `dashboard/engagement`). Roughly 16 of 24 required cards are covered.

Missing cards: Online Users, Monthly Active Users, Managers, Officials, Moderators, BD, Pending Tickets, Pending Verifications. Also missing: every widget must link to its management page — currently several screens render a raw JSON dump via the generic `MetricsScreen`.

Deferred to Phase 4 deliberately: the cards should link to management pages, which do not exist until Phases 2 and 3 land.

---

### Phase 5 — Rooms, Streams & Games
**Spec sections 13, 14, 15**

26 room controllers already exist (11 audio, 15 video), and all 10 required games are present with an `admin/games` controller.

- **Invisible Join (§13, §14) does not exist and is the significant build here** — an admin presence that is excluded from member lists, viewer counts, and presence broadcasts. Phase 1's hidden-account flag is the prerequisite.
- Room actions: Close, Lock, Logs, Chat, Gift History, Reports, Record, Screenshot.
- Games: Enable, Disable, Maintenance, Multipliers, Rewards, Revenue, Players, Betting History, Audit.

---

### Phase 6 — Wallet, Revenue & Payments
**Spec section 16**

`super-admin/wallets` covers summary, balance, ledger, transactions, reservations, audit, credit, debit, transfer. `admin/wallet` adds adjust and recovery.

Gaps: freeze/unfreeze routes, refund flow, creator revenue share editor, reward percentage editor, withdrawal review queue UI. Every action must go through the existing wallet transaction service and `AuditLogService` — no new ledger logic.

---

### Phase 7 — Verification, Reports & Content
**Spec sections 17, 18, 21**

- **Verification (§17):** `VerificationType` is currently `IDENTITY | CELEBRITY | OFFICIAL | CREATOR`. The spec requires Artists, Singers, Gaming, Influencers, Brands, Creators — an enum migration plus a review queue UI.
- **Reports (§21):** enums cover `ABUSE`, `SPAM`, `HARASSMENT`, `FRAUD`, `COPYRIGHT`. **`VIOLENCE` and `FAKE` are missing.** Actions needed: Suspend, Remove Ban, Close, Escalate.
- **Content (§18):** the `cosmetics` module and `admin/cosmetics` controller exist and already own asset storage. This is a UI-only phase for Gifts, VIP, Frames, Entry Effects, Badges, Themes, Backgrounds, Animations, Assets, Festival Content — reuse the existing asset infrastructure, add no storage logic.

---

### Phase 8 — Events, Tasks, Settings & Audit UI
**Spec sections 19, 20, plus the sidebar tail**

`enterprise-events`, `admin/events`, `tasks` and `admin/treasure` all exist; the console renders them as raw JSON. Build real screens for Events (Create, Schedule, Rewards, Treasure, Leaderboards, Festival Campaigns), Tasks (Assign across all six staff types, with Priority/Target/Progress/Remarks/Performance), Platform Settings, and Audit Logs.

---

## Sequencing and dependencies

```
Phase 1 (Identity + Login)
   │  hidden-account flag is a hard prerequisite
   ├────────────────────────────► Phase 5 (Invisible Join)
   │
   └─► Phase 2 (Console + Users) ──┬─► Phase 3 (Staff & Partners) ─┐
                                   │                               ├─► Phase 4 (Dashboard links)
                                   ├─► Phase 6 (Wallet)            │
                                   ├─► Phase 7 (Verification…)     │
                                   └─► Phase 8 (Events, Tasks)  ───┘
```

Phase 1 blocks Phase 5. Phase 2 establishes the management-page pattern that Phases 3, 6, 7 and 8 reuse, so it should not run in parallel with them. Phase 4 goes last among the UI phases because its widgets link to pages built in 2, 3, 6, 7 and 8.

---

## The one spec conflict, and how it is resolved

The spec says **"Do NOT modify existing business engines"**, but Section 1 requires hiding Admins from search, rankings, followers, room members and live viewers — filters that can only live inside those engines.

**Resolution:** additive filtering at existing seams, never redesign.

- `ProfileService.search()` already computes an `excludeIds` array for blocked users. Hidden accounts join that array. No new mechanism.
- `ProfileService.getCards()` gains a filter over its existing result set. Signature unchanged, so its 9 consumers are untouched.
- Rankings gain a write-side guard.

Total footprint inside frozen modules: 3 files, all additive. No business rule is redesigned and no engine is bypassed. This is documented here because it is a conscious, reviewed deviation from the letter of the freeze, made because the requirement cannot be satisfied any other way.

---

## Deliberately out of scope

Called out so nobody assumes they were forgotten:

- **Screenshot and Record (§13, §14)** need a media pipeline decision (server-side capture vs. client upload) that is not an admin-role question. Flagged for a separate spec.
- **Pending Tickets (§3)** implies a support-ticket system. No ticketing module exists anywhere in the backend. Either a module is built or the card is dropped — a product decision, not an implementation one.
- **OTP on admin login (§2)** is marked *optional* in the spec. Phase 1 ships TOTP 2FA; SMS/email OTP as a second factor is left out unless requested.
