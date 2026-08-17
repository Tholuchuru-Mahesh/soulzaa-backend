// test/moderator-region-scope.e2e-spec.ts
import { ValidationPipe, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';

/**
 * Proves RoleScope — not User.stateId — gates Moderator access, across
 * one-state, multi-state, and revoked-state cases. Requires `npm run
 * seed:e2e` to have run against .env.e2e first (the e2e Postgres on port
 * 5433 — never the primary dev DB); this suite is idempotent but not
 * self-seeding.
 *
 * Moderator RoleScope allocation stops at State (Region was removed from
 * moderation scoping — see WorkforceScopeService, ModeratorProvisioningService).
 * Rooms carry no territory snapshot column either: scope checks resolve the
 * room OWNER's stateId/countryId live, so each fixture room owner's own
 * location IS the room's effective territory (see seed-e2e-fixtures.ts).
 */
// Route params bound with `ParseUuidPipe` are validated as UUID v4
// specifically (13th hex digit must be '4', 17th must be 8/9/a/b — see
// src/common/pipes/parse-uuid.pipe.ts). The brief's placeholder
// '00000000-0000-0000-0000-000000000e2e' does NOT satisfy that (its 3rd
// group is '0000', not '4xxx') so it fails pipe validation with 400 before
// the handler — and therefore before the owner-scope check — ever runs,
// which would silently invalidate every 403 assertion built on it. This
// placeholder is v4-shaped so the request reaches the scope check, while
// still not colliding with any seeded fixture user.
const PLACEHOLDER_TARGET_USER_ID = '00000000-0000-4000-8e2e-000000000000';

describe('Moderator state scope enforcement (e2e)', () => {
  let app: INestApplication;
  let moderatorToken: string;
  let officialToken: string;
  let adminToken: string;
  let roomIds: { ka: string; ap: string; tn: string };
  let moderatorId: string;
  let adminId: string;
  let stateIds: { ka: string; ap: string; tn: string };

  const prisma = new PrismaClient();

  async function loginAs(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/staff/auth/login')
      .send({ email, password: 'E2ePass!2026' });
    expect(res.status).toBe(200);
    return res.body.data.tokens.accessToken;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready', 'metrics'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    moderatorToken = await loginAs('moderator@e2e.test');
    officialToken = await loginAs('official@e2e.test');
    adminToken = await loginAs('admin@e2e.test');

    const rooms = await prisma.audioRoom.findMany({
      where: { agoraChannel: { in: ['e2e-room-ka', 'e2e-room-ap', 'e2e-room-tn'] } },
      select: { id: true, agoraChannel: true },
    });
    roomIds = {
      ka: rooms.find((r) => r.agoraChannel === 'e2e-room-ka')!.id,
      ap: rooms.find((r) => r.agoraChannel === 'e2e-room-ap')!.id,
      tn: rooms.find((r) => r.agoraChannel === 'e2e-room-tn')!.id,
    };

    const moderatorUser = await prisma.user.findUnique({ where: { email: 'moderator@e2e.test' } });
    const adminUser = await prisma.user.findUnique({ where: { email: 'admin@e2e.test' } });
    moderatorId = moderatorUser!.id;
    adminId = adminUser!.id;

    const country = await prisma.country.findUnique({ where: { code: 'IN' } });
    const stateKA = await prisma.state.findFirst({ where: { countryId: country!.id, code: 'KA' } });
    const stateAP = await prisma.state.findFirst({ where: { countryId: country!.id, code: 'AP' } });
    const stateTN = await prisma.state.findFirst({ where: { countryId: country!.id, code: 'TN' } });
    stateIds = { ka: stateKA!.id, ap: stateAP!.id, tn: stateTN!.id };

    // rooms/moderation/{kick,unkick,warn}/:userId and .../reports/:reportId/dismiss
    // are gated by ShiftActiveGuard + SuspendedGuard for MODERATOR actors.
    // SuspendedGuard passes by default (no ModeratorWarningRecord seeded —
    // do not create one). ShiftActiveGuard needs a real ModeratorShift row
    // covering "now"; seed one spanning all 7 days, full 24h window, so the
    // guard never flakes on time-of-day. A fixed id makes this upsert-idempotent.
    await prisma.moderatorShift.upsert({
      where: { id: '00000000-0000-0000-0000-0000000e2e01' },
      create: {
        id: '00000000-0000-0000-0000-0000000e2e01',
        moderatorId,
        daysOfWeek: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],
        startHour: 0,
        startMinute: 0,
        endHour: 23,
        endMinute: 59,
        assignedBy: adminId,
      },
      update: {
        daysOfWeek: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],
        startHour: 0,
        startMinute: 0,
        endHour: 23,
        endMinute: 59,
        isActive: true,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await app?.close();
  });

  describe('scenarios 1-3: provisioned states and single-state access', () => {
    it("1. GET /states reflects exactly the moderator's provisioned states (Karnataka + Andhra Pradesh)", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin-identity/moderators/${moderatorId}/states`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const ids: string[] = res.body.data.stateIds;
      expect(ids.sort()).toEqual([stateIds.ap, stateIds.ka].sort());
      expect(ids).not.toContain(stateIds.tn);
    });

    it('2 & 3. moderator can view the Karnataka room (assigned state)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/rooms/${roomIds.ka}`)
        .set('Authorization', `Bearer ${moderatorToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('scenarios 4-6: multi-state access, deny, and revoke', () => {
    it('4. moderator can act on the Andhra Pradesh room (second assigned state)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.ap}/moderation/warn/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 4' });
      // Target-user-not-found errors are acceptable (404/400) — a 403
      // ForbiddenException specifically would mean the scope check itself
      // rejected the assigned state, which is what this test guards against.
      expect(res.status).not.toBe(403);
    });

    it('5. moderator cannot act on the Tamil Nadu room (unassigned state)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.tn}/moderation/warn/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 5' });
      expect(res.status).toBe(403);
    });

    it('6. removing Andhra Pradesh from the moderator states immediately revokes access', async () => {
      await request(app.getHttpServer())
        .put(`/api/admin-identity/moderators/${moderatorId}/states`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ stateIds: [stateIds.ka] });

      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.ap}/moderation/warn/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 6 — should now be denied' });
      expect(res.status).toBe(403);

      // Restore full scope so later scenarios/re-runs aren't affected by ordering.
      // Verified against ModeratorProvisioningService.setModeratorStates: it
      // fully reconciles the RoleScope STATE set to exactly the given
      // stateIds (removes scopes not in the new set, adds ones missing) —
      // a true replace, not additive — so sending [ka] alone above really
      // did narrow scope to Karnataka-only, and this restores both.
      await request(app.getHttpServer())
        .put(`/api/admin-identity/moderators/${moderatorId}/states`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ stateIds: [stateIds.ka, stateIds.ap] });
    });
  });

  describe('scenarios 7-9: moderation actions, reports, and restorative actions all enforce scope', () => {
    it('7. kick on the unassigned Tamil Nadu room is denied', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.tn}/moderation/kick/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 7' });
      expect(res.status).toBe(403);
    });

    it('8. dismissing a report on the unassigned Tamil Nadu room is denied', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.tn}/moderation/reports/${PLACEHOLDER_TARGET_USER_ID}/dismiss`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 8' });
      expect(res.status).toBe(403);
    });

    it('9. unkick on the unassigned Tamil Nadu room is denied (restorative action regression guard)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.tn}/moderation/unkick/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('scenarios 10-11: approval decisions and investigation recording respect scope', () => {
    it('10. an Official scoped to Karnataka cannot decide an approval whose room is owned in Tamil Nadu', async () => {
      // Seed a PENDING approval row directly for roomIds.tn — bypasses the
      // full report-review -> propose() flow per the brief's explicit
      // shortcut authorization for this scenario. Field shapes verified
      // against prisma/schema/moderation_approval.prisma and
      // ModerationApprovalService.propose()/decide(): roomType/roomId
      // identify the resource decide() -> resolveOwnerId() looks up;
      // reportId, proposedBy and targetUserId are required non-null columns
      // with no enforced FK relation in the schema, so any well-formed UUID
      // works — moderatorId/adminId are real seeded users, used here for realism.
      const approval = await prisma.moderationActionApproval.create({
        data: {
          roomType: 'AUDIO_ROOM',
          roomId: roomIds.tn,
          reportId: '00000000-0000-4000-8000-000000000001',
          proposedBy: moderatorId,
          targetUserId: PLACEHOLDER_TARGET_USER_ID,
          action: 'BAN',
          reason: 'e2e scenario 10 seed',
          status: 'PENDING',
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/moderation/approvals/${approval.id}/decide`)
        .set('Authorization', `Bearer ${officialToken}`)
        .send({ decision: 'APPROVED' });
      expect(res.status).toBe(403);
    });

    it('11. investigation recordings created via a scoped action are retrievable by an Admin and carry no bypass', async () => {
      const kickRes = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.ka}/moderation/kick/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 11' });
      expect(kickRes.status).not.toBe(403);

      // `kick` opens its recording INSIDE the room lock, after an active-
      // membership check the placeholder target cannot satisfy, so it stops at
      // 409 before any recording row exists. `warn` has no membership
      // precondition — it records unconditionally once the owner-scope check
      // passes — so it is the action that actually produces the row this
      // scenario then asserts on. Both are owner-scope gated identically;
      // the kick above still proves Karnataka is in scope.
      const warnRes = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.ka}/moderation/warn/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 11 — warn produces the recording' });
      expect(warnRes.status).not.toBe(403);

      // No self-service "my recordings" route exists for a MODERATOR actor
      // (investigation.recording.view is not in the MODERATOR permission set —
      // confirmed by prior research). Use the admin-only listing route instead,
      // passing the moderator's own id — this still proves the recording was
      // created and is retrievable without a scope bypass; it does not itself
      // exercise owner-scope enforcement on the read path (Admin is
      // unrestricted by design).
      const listRes = await request(app.getHttpServer())
        .get(`/api/admin/investigation-recordings/moderator/${moderatorId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(listRes.status).toBe(200);
      const items = listRes.body.data.items;
      expect(Array.isArray(items)).toBe(true);

      // An empty array used to satisfy this scenario. Assert the list really
      // carries the recording THIS scenario's action produced, matched on the
      // room it was taken in and the user it was taken against.
      const match = items.find(
        (r: any) =>
          r.roomId === roomIds.ka &&
          r.targetUserId === PLACEHOLDER_TARGET_USER_ID &&
          r.moderatorId === moderatorId,
      );
      expect(match).toBeDefined();
    });
  });

  describe('scenario 12: dashboard is restricted to operational scope', () => {
    // Fixed ids so the pair can be torn down and re-created deterministically
    // on every run — the assertion below is a delta, so a leftover row from a
    // previous run would fold into the baseline and hide a regression.
    const KA_REPORT_ID = '00000000-0000-4000-8000-0000000012b1';
    const TN_REPORT_ID = '00000000-0000-4000-8000-0000000012c1';

    const dashboard = async () => {
      const res = await request(app.getHttpServer())
        .get('/api/mobile/workforce/me/dashboard')
        .set('Authorization', `Bearer ${moderatorToken}`);
      expect(res.status).toBe(200);
      return res.body.data;
    };

    it('12. moderator dashboard reflects only Karnataka + Andhra Pradesh, never Tamil Nadu', async () => {
      const data = await dashboard();
      const roomIdsInDashboard = (data.assignedAudioRooms ?? []).map((r: any) => r.id);
      expect(roomIdsInDashboard).not.toContain(roomIds.tn);
      // The list is scoped by the room OWNER's live state, so the in-scope
      // Karnataka room must actually be present — "not Tamil Nadu" alone is
      // also satisfied by an empty list.
      expect(roomIdsInDashboard).toContain(roomIds.ka);
    });

    it("12b. assignedReportsCount counts the in-scope room's report and not the out-of-scope room's", async () => {
      // Seeded directly via Prisma, mirroring scenario 10's
      // ModerationActionApproval shortcut. RoomReport's required columns per
      // prisma/schema/audio_rooms_moderation.prisma are roomId, reporterId,
      // targetUserId and reason; the rest default (status defaults to PENDING).
      // reporterId/targetUserId carry no declared FK relation, so any
      // well-formed UUID works — real seeded ids are used for realism.
      await prisma.roomReport.deleteMany({
        where: { id: { in: [KA_REPORT_ID, TN_REPORT_ID] } },
      });

      const before = await dashboard();
      const baseline = before.assignedReportsCount;
      expect(typeof baseline).toBe('number');

      await prisma.roomReport.createMany({
        data: [
          {
            id: KA_REPORT_ID,
            roomId: roomIds.ka,
            reporterId: adminId,
            targetUserId: PLACEHOLDER_TARGET_USER_ID,
            reason: 'SPAM',
            description: 'e2e scenario 12 — in-scope (Karnataka)',
          },
          {
            id: TN_REPORT_ID,
            roomId: roomIds.tn,
            reporterId: adminId,
            targetUserId: PLACEHOLDER_TARGET_USER_ID,
            reason: 'SPAM',
            description: 'e2e scenario 12 — out-of-scope (Tamil Nadu)',
          },
        ],
      });

      const after = await dashboard();
      // Exactly one of the two new reports may be counted: the Karnataka one.
      // A +2 delta would mean the Tamil Nadu report leaked past state scope; a
      // +0 delta would mean the in-scope report was wrongly excluded.
      expect(after.assignedReportsCount).toBe(baseline + 1);

      await prisma.roomReport.deleteMany({
        where: { id: { in: [KA_REPORT_ID, TN_REPORT_ID] } },
      });
    });
  });
});
