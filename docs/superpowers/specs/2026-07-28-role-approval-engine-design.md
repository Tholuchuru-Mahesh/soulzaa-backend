# Role Approval & Lifecycle Engine — Design

**Date:** 2026-07-28
**Status:** Approved (design), pending implementation plan
**Sub-project:** A of the roles programme
**PRD references:** Agency Registration; Coin Seller Eligibility; Moderator Recommendation; Business Development Recommendation; Official role spec (approval workflows and restrictions)

## Problem

Every role below Super Admin is an identity with permissions but no provenance. A
Super Admin can write a `UserRole` row for anyone; nothing else can create a role.
The PRD describes four approval chains that do not exist in any form — there are no
application, approval or recommendation models anywhere in the schema.

The consequence is that the hierarchy the PRD is built around is decorative. An
Official has nothing to verify, a Country Manager has nothing to review, and an
Admin has nothing to approve. This engine is what makes those stages real, which is
why it comes before the operational sub-projects (moderator shifts, support tickets,
staff tasks) that assume properly-created staff.

## Scope

Four flows, one engine:

| Flow | Initiated by | Pipeline | Grants |
| --- | --- | --- | --- |
| Agency application | the applicant | `OFFICIAL → MANAGER → ADMIN` | `AGENCY` |
| Coin Seller eligibility | the agency | `OFFICIAL → MANAGER → ADMIN` | `COIN_SELLER` |
| Moderator recommendation | an Official | `MANAGER → ADMIN` | `MODERATOR` |
| BD recommendation | an Official | `MANAGER → ADMIN` | `BUSINESS_DEVELOPMENT` |

Agency and Coin Seller are *applications*: the subject applies and an Official
verifies. Moderator and BD are *recommendations*: the PRD has the Official identify
and verify the candidate before submitting, so their submission **is** the
verification and a second Official stage would be theatre.

Coin Seller grants onto the **same account** as the agency — the PRD is explicit
that it is an additional permission inside an existing Agency account, not a new one.

**Who may submit which type** is enforced in the service, not by permission alone,
because all four share one endpoint:

| Type | Submitter must be | Subject is |
| --- | --- | --- |
| `AGENCY` | any member, for themselves | the submitter |
| `COIN_SELLER` | a member already holding `AGENCY`, for themselves | the submitter |
| `MODERATOR` | an Official | another user, named by the Official |
| `BUSINESS_DEVELOPMENT` | an Official | another user, named by the Official |

A member submitting a `MODERATOR` request for themselves, or an Official submitting
an `AGENCY` request on someone else's behalf, is a `403`.

## Decisions

| Question | Decision |
| --- | --- |
| Eligibility criteria | Advisory checklist the Official attests; nothing auto-blocked |
| Documents | Store references (keys) only; no upload flow in this sub-project |
| Non-final stage powers | Advance or send back for more info; only Admin approves/rejects |
| Routing | Pooled by geographic scope, not assigned to an individual |
| Reapplication | One open request per (subject, type); reapply freely after a decision |
| Activation | Immediate on approval; the PRD's "24–48 hours" is an operational SLA |

## Architecture

A new `src/modules/role-requests` module. It consumes existing public ports and adds
no module-boundary violations:

- RBAC role/scope writes and cache invalidation — through a new `AUTHORIZATION_GRANT`
  port added to `src/modules/authorization/interfaces/`, mirroring the `PLATFORM_CONFIG`
  port. Importing `RoleService`/`AuthorizationCacheService` directly would add
  boundary violations to a count that has held at 215.
- `NOTIFICATION_SERVICE` for applicant-facing status updates.
- `EVENT_BUS` for domain events other modules consume.
- `ORGANIZATION` services for resolving the subject's country/state/region.

## Data model

### `RoleRequest` — the live request

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid | primary key |
| `reference` | String, unique | human-readable, e.g. `RR-2026-000154` |
| `type` | enum | `AGENCY \| COIN_SELLER \| MODERATOR \| BUSINESS_DEVELOPMENT` |
| `subjectUserId` | uuid | who would receive the role |
| `initiatedByUserId` | uuid | the applicant, or the recommending Official |
| `status` | enum | see lifecycle below |
| `currentStage` | enum? | `OFFICIAL \| MANAGER \| ADMIN`, null once terminal |
| `currentStageEnteredAt` | DateTime? | drives time-in-stage |
| `pipelineVersion` | Int | the pipeline definition in force when submitted |
| `formData` | Json | flow-specific application fields |
| `documentKeys` | String[] | storage keys the applicant already uploaded |
| `countryId` / `stateId` / `regionId` | uuid? | routing scope, resolved at submit |
| `submittedAt` | DateTime | |
| `decidedAt` | DateTime? | |
| `decidedByUserId` | uuid? | |
| `outcomeReason` | String? | rejection reason, send-back reason, or cancel reason |

Partial unique index enforcing **one open request per (subjectUserId, type)** while
status is non-terminal. The database is the guarantee; the service check alone would
lose a concurrent double-submit.

### `RoleRequestAction` — append-only decision log

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid | |
| `requestId` | uuid | |
| `sequence` | Int | monotonic per request |
| `stage` | enum | the stage this action completed |
| `action` | enum | `SUBMIT \| ADVANCE \| SEND_BACK \| RESUBMIT \| APPROVE \| REJECT \| WITHDRAW \| CANCEL` |
| `actorUserId` | uuid | |
| `actorRole` | String | the role the actor acted in, captured at the time |
| `notes` | String? | reviewer's free text |
| `checklistSnapshot` | Json? | the full checklist state as attested, not a delta |
| `stageEnteredAt` | DateTime | when the stage this action closes was entered |
| `actedAt` | DateTime | |

Never updated, never deleted. `stageEnteredAt` and `actedAt` together give
time-in-stage per action without a second table.

### `RoleRequestCounter` — reference number allocation

One row per year: `{ year: Int @id, lastSequence: Int }`. A reference is allocated by
an atomic increment inside the submitting transaction, so two concurrent submits
cannot collide. Format: `RR-{year}-{sequence padded to 6}`.

## Lifecycle

```
                    ┌──────────────────────────────┐
                    ▼                              │ resubmit
SUBMITTED → IN_REVIEW ──advance──▶ IN_REVIEW ──advance──▶ IN_REVIEW(ADMIN)
                 │                                              │
            send_back                                    approve │ reject
                 ▼                                              ▼
            NEEDS_INFO                                 APPROVED │ REJECTED

  withdraw (subject/initiator, any non-terminal) ──▶ WITHDRAWN
  cancel   (Admin, any non-terminal)             ──▶ CANCELLED
```

Terminal states: `APPROVED`, `REJECTED`, `WITHDRAWN`, `CANCELLED`.

Send-back is available from **every** stage including Admin — the diagram shows it
once for readability. Withdraw is available to the subject at any non-terminal state,
and additionally to the recommending Official on `MODERATOR` and `BUSINESS_DEVELOPMENT`
requests; a candidate who does not want the role can decline one raised about them.

**Withdraw and cancel are distinct**, per the refinement. Withdraw is the subject or
the recommending Official retracting their own request — a neutral act. Cancel is an
administrative termination by an Admin, used for duplicates, spam, or a subject who
has since been suspended. They differ in who may act and in what the audit trail
means, so collapsing them would lose information a support investigation needs.

## Stage powers

| Stage | advance | send_back | approve | reject | cancel |
| --- | --- | --- | --- | --- | --- |
| OFFICIAL | ✅ | ✅ | ❌ | ❌ | ❌ |
| MANAGER | ✅ | ✅ | ❌ | ❌ | ❌ |
| ADMIN | ❌ | ✅ | ✅ | ✅ | ✅ |

The PRD states plainly that Officials cannot approve or reject agencies; the same
restriction is applied to every flow and to Managers, so the decision stays where the
document puts it. Send-back exists so incomplete submissions are filtered without
moving that authority downward — it mirrors the "Return Incomplete Reports" power the
PRD already grants Officials.

A sent-back request re-enters at the **first stage of its pipeline** on resubmit, so
an Official's attestation is never inherited by a materially changed application.

## Routing and visibility

**The operating region is supplied at submit, not derived from the profile.**
`User.country` and `UserProfile.state` are free-text strings, not foreign keys to the
Organization `Country`/`State`/`Region` tables, so a subject's `regionId` cannot be
resolved from their profile at all. The submitter therefore selects the region they
operate in; it is validated against the Organization module and must be active, and
`stateId`/`countryId` derive from it through the hierarchy. An invalid or inactive
region is a `400`.

This also means the free-text profile country plays no part in routing, which avoids
the failure mode where a user typing "India" instead of "IN" silently lands in the
wrong queue.

Visibility is then scope-derived:

- **Official stage** — visible to any user holding `OFFICIAL` whose `RoleScope`
  covers the request's region.
- **Manager stage** — visible to the Country Manager(s) for the request's country.
- **Admin stage** — visible to any `ADMIN` or `SUPER_ADMIN`.

Pooled rather than assigned to an individual: the PRD allows several Officials per
region, and one person's absence must not stall a queue. Whoever acts is recorded on
the action row, so accountability survives pooling.

An Official querying a request outside their scope receives 404, not 403 — the PRD
says Officials cannot access other regions' data, and a 403 would confirm the
request exists.

## Approval

On `APPROVE`, inside one transaction:

1. Write the `UserRole` row for the granted role.
2. Write its `RoleScope`, using the region supplied at submit:

   | Type | `scopeType` | Scope written |
   | --- | --- | --- |
   | `AGENCY` | REGION | the request's `regionId` |
   | `COIN_SELLER` | REGION | the request's `regionId` (matching the agency's) |
   | `MODERATOR` | REGION | the request's `regionId` |
   | `BUSINESS_DEVELOPMENT` | REGION | the request's `regionId` |

   All four are region-scoped in this sub-project. Country- and state-level scopes
   exist in `RoleScope` and are used by Country Manager and Official assignment,
   which the Super Admin workforce APIs already own and this engine does not touch.
3. Set the request terminal: `APPROVED`, `decidedAt`, `decidedByUserId`.
4. Append the `APPROVE` action row.

Then, after commit:

5. **Invalidate the authorization cache for the subject.** Without this the new role
   would not take effect until the Redis TTL expired — indistinguishable, to the
   user, from an approval that silently failed.
6. Publish `RoleGrantedEvent` on the event bus.
7. Notify the subject.

Steps 5–7 are post-commit because they are not rollback-able and must not undo a
recorded decision. Failures there are logged at `error` with the request reference,
the subject and the granted role — enough to reconcile by hand.

## Events and notifications

**Every stage transition emits a notification to the subject** — submitted,
advanced, sent back, approved, rejected, withdrawn, cancelled — through
`NOTIFICATION_SERVICE`. The message names the request reference so a user can quote
it to support.

Domain events published on the bus:

| Event | When |
| --- | --- |
| `role.request.submitted` | on submit |
| `role.request.advanced` | a stage passes it forward |
| `role.request.sent_back` | returned for more information |
| `role.request.decided` | approved or rejected |
| `role.request.closed` | withdrawn or cancelled |
| `role.granted` | **after** a successful grant commits |

`role.granted` carries `{ userId, role, scope, requestId, reference, grantedBy }`. It
exists so badges, notifications, analytics and future onboarding can react without
this module knowing they exist.

## Pipeline versioning

Each request stores the `pipelineVersion` in force when it was submitted. The
pipeline definitions live in code, keyed by version. A request is always evaluated
against the version it started under, so changing a chain later cannot retroactively
alter what an in-flight or historical request meant. Version 1 is the table in the
Scope section.

## SLA timestamps

`currentStageEnteredAt` on the request plus `stageEnteredAt`/`actedAt` on each action
give, without further modelling:

- time in the current stage, for a "waiting on you" queue
- time spent in each completed stage, per request
- total submit-to-decision duration

Left to the operational dashboards sub-project: aggregate SLA targets, breach alerts
and per-reviewer averages. This spec only guarantees the timestamps exist and are
accurate.

## Permissions

Five new codes, added to the RBAC catalogue and the role matrix:

| Code | Granted to |
| --- | --- |
| `role_request.submit` | every member (an application is a member action) |
| `role_request.view` | OFFICIAL, COUNTRY_MANAGER, ADMIN (scope-filtered) |
| `role_request.verify` | OFFICIAL |
| `role_request.review` | COUNTRY_MANAGER |
| `role_request.decide` | ADMIN |

The existing guard tests enforce the rest: every enforced code must be defined and
seeded, no member-tier role may hold a permission guarding an administrative route,
and Super-Admin-only authority must not leak downward.

## API

| Route | Who | Purpose |
| --- | --- | --- |
| `POST /role-requests` | member / Official | submit an application or recommendation |
| `GET /role-requests` | staff | scope-filtered queue, filterable by type and status |
| `GET /role-requests/mine` | member | the caller's own requests |
| `GET /role-requests/:id` | staff / subject | detail with full action history |
| `POST /role-requests/:id/advance` | Official, Manager | pass to the next stage |
| `POST /role-requests/:id/send-back` | Official, Manager, Admin | return for more info |
| `POST /role-requests/:id/resubmit` | subject / initiator | after a send-back |
| `POST /role-requests/:id/decide` | Admin | approve or reject |
| `POST /role-requests/:id/withdraw` | subject / initiator | retract |
| `POST /role-requests/:id/cancel` | Admin | administrative termination |

## Error handling

| Case | Behaviour |
| --- | --- |
| Second open request for the same (subject, type) | `409` naming the open request's reference |
| Action attempted from the wrong stage | `409` stating the current stage |
| Official approving or rejecting | `403` |
| Staff acting outside their geographic scope | `404` |
| Resubmit when not in `NEEDS_INFO` | `409` |
| Any action on a terminal request | `409` |
| Subject already holds the role | `409` at submit |
| Cache invalidation or notification fails post-commit | logged at `error`; the approval stands |

## Testing

The state machine carries the risk, so it carries the coverage: every illegal
transition rejected, an Official unable to approve, a Manager unable to skip to
decide, a send-back returning to the first stage on resubmit, and terminal states
refusing all further actions.

Beyond that: scope-filtered visibility denying a foreign Official; the one-open-request
constraint holding under concurrent submits; reference numbers unique under
concurrency; the checklist snapshot persisted whole rather than as a delta;
`pipelineVersion` pinned at submit and not re-read later; the authorization cache
invalidated on grant; and `role.granted` published only after the transaction commits,
never before.

## Out of scope

Document upload, automated eligibility computation, agency performance grading,
reviewer workload balancing, SLA breach alerting, and the staff-facing dashboards that
will consume these timestamps. Each belongs to a later sub-project.
