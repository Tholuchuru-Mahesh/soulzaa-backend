// test/moderator-region-scope.e2e-spec.ts
import { ValidationPipe, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';

/**
 * Proves RoleScope — not User.regionId — gates Moderator access, across
 * one-region, multi-region, and revoked-region cases. Requires `npm run
 * seed:e2e` to have run against .env.e2e first (the e2e Postgres on port
 * 5433 — never the primary dev DB); this suite is idempotent but not
 * self-seeding.
 */
// Route params bound with `ParseUuidPipe` are validated as UUID v4
// specifically (13th hex digit must be '4', 17th must be 8/9/a/b — see
// src/common/pipes/parse-uuid.pipe.ts). The brief's placeholder
// '00000000-0000-0000-0000-000000000e2e' does NOT satisfy that (its 3rd
// group is '0000', not '4xxx') so it fails pipe validation with 400 before
// the handler — and therefore before the region-scope check — ever runs,
// which would silently invalidate every 403 assertion built on it. This
// placeholder is v4-shaped so the request reaches the scope check, while
// still not colliding with any seeded fixture user.
const PLACEHOLDER_TARGET_USER_ID = '00000000-0000-4000-8e2e-000000000000';

describe('Moderator region scope enforcement (e2e)', () => {
  let app: INestApplication;
  let moderatorToken: string;
  let officialToken: string;
  let adminToken: string;
  let roomIds: { blr: string; vja: string; chn: string };
  let moderatorId: string;
  let adminId: string;
  let regionIds: { blr: string; vja: string; chn: string };

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
      where: { agoraChannel: { in: ['e2e-room-blr', 'e2e-room-vja', 'e2e-room-chn'] } },
      select: { id: true, agoraChannel: true },
    });
    roomIds = {
      blr: rooms.find((r) => r.agoraChannel === 'e2e-room-blr')!.id,
      vja: rooms.find((r) => r.agoraChannel === 'e2e-room-vja')!.id,
      chn: rooms.find((r) => r.agoraChannel === 'e2e-room-chn')!.id,
    };

    const moderatorUser = await prisma.user.findUnique({ where: { email: 'moderator@e2e.test' } });
    const adminUser = await prisma.user.findUnique({ where: { email: 'admin@e2e.test' } });
    moderatorId = moderatorUser!.id;
    adminId = adminUser!.id;

    const blrRegion = await prisma.region.findFirst({ where: { code: 'BLR' } });
    const vjaRegion = await prisma.region.findFirst({ where: { code: 'VJA' } });
    const chnRegion = await prisma.region.findFirst({ where: { code: 'CHN' } });
    regionIds = { blr: blrRegion!.id, vja: vjaRegion!.id, chn: chnRegion!.id };

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

  describe('scenarios 1-3: profile independence, single and multi region access', () => {
    it('1. moderator profile geography (BLR) does not by itself explain VJA access — see scenario 4', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/organization/users/${moderatorId}/location`)
        .set('Authorization', `Bearer ${moderatorToken}`);
      expect(res.status).toBe(200);
      // Profile geography reflects only the moderator's first RoleScope entry
      // (BLR) — it was never told about VJA. Scenario 4 proves the moderator
      // can still act on VJA anyway, which can only be explained by RoleScope,
      // not by this profile field. That is the actual independence proof:
      // operational access exceeds what profile geography alone would grant.
      expect(res.body.data.regionId).toBe(regionIds.blr);
      expect(res.body.data.regionId).not.toBe(regionIds.vja);
    });

    it('2 & 3. moderator can view the Bengaluru room (assigned region)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/rooms/${roomIds.blr}`)
        .set('Authorization', `Bearer ${moderatorToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('scenarios 4-6: multi-region access, deny, and revoke', () => {
    it('4. moderator can act on the Vijayawada room (second assigned region, absent from profile geography)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.vja}/moderation/warn/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 4' });
      // Target-user-not-found errors are acceptable (404/400) — a 403
      // ForbiddenException specifically would mean the region check itself
      // rejected the assigned region, which is what this test guards against.
      expect(res.status).not.toBe(403);
    });

    it('5. moderator cannot act on the Chennai room (unassigned region)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.chn}/moderation/warn/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 5' });
      expect(res.status).toBe(403);
    });

    it('6. removing the Vijayawada RoleScope immediately revokes access', async () => {
      await request(app.getHttpServer())
        .put(`/api/admin-identity/moderators/${moderatorId}/regions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ regionIds: [regionIds.blr] });

      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.vja}/moderation/warn/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 6 — should now be denied' });
      expect(res.status).toBe(403);

      // Restore full scope so later scenarios/re-runs aren't affected by ordering.
      // Verified against ModeratorProvisioningService.setModeratorRegions: it
      // fully reconciles the RoleScope REGION set to exactly the given
      // regionIds (removes scopes not in the new set, adds ones missing) —
      // a true replace, not additive — so sending [blr] alone above really
      // did narrow scope to BLR-only, and this restores both.
      await request(app.getHttpServer())
        .put(`/api/admin-identity/moderators/${moderatorId}/regions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ regionIds: [regionIds.blr, regionIds.vja] });
    });
  });

  describe('scenarios 7-9: moderation actions, reports, and restorative actions all enforce scope', () => {
    it('7. kick on the unassigned Chennai room is denied', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.chn}/moderation/kick/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 7' });
      expect(res.status).toBe(403);
    });

    it('8. dismissing a report on the unassigned Chennai room is denied', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.chn}/moderation/reports/${PLACEHOLDER_TARGET_USER_ID}/dismiss`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 8' });
      expect(res.status).toBe(403);
    });

    it('9. unkick on the unassigned Chennai room is denied (restorative action regression guard)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.chn}/moderation/unkick/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('scenarios 10-11: approval decisions and investigation recording respect scope', () => {
    it('10. an Official scoped to Karnataka cannot decide an approval whose room is in Chennai (Tamil Nadu)', async () => {
      // Seed a PENDING approval row directly for roomIds.chn — bypasses the
      // full report-review -> propose() flow per the brief's explicit
      // shortcut authorization for this scenario. Field shapes verified
      // against prisma/schema/moderation_approval.prisma and
      // ModerationApprovalService.propose(): roomType/roomId identify the
      // resource decide() -> resolveRegion() looks up; reportId,
      // proposedBy and targetUserId are required non-null columns with no
      // enforced FK relation in the schema, so any well-formed UUID works —
      // moderatorId/adminId are real seeded users, used here for realism.
      const approval = await prisma.moderationActionApproval.create({
        data: {
          roomType: 'AUDIO_ROOM',
          roomId: roomIds.chn,
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
        .post(`/api/rooms/${roomIds.blr}/moderation/kick/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 11' });
      expect(kickRes.status).not.toBe(403);

      // `kick` opens its recording INSIDE the room lock, after an active-
      // membership check the placeholder target cannot satisfy, so it stops at
      // 409 before any recording row exists. `warn` has no membership
      // precondition — it records unconditionally once the region-scope check
      // passes — so it is the action that actually produces the row this
      // scenario then asserts on. Both are region-scope gated identically;
      // the kick above still proves BLR is in scope.
      const warnRes = await request(app.getHttpServer())
        .post(`/api/rooms/${roomIds.blr}/moderation/warn/${PLACEHOLDER_TARGET_USER_ID}`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ reason: 'e2e scenario 11 — warn produces the recording' });
      expect(warnRes.status).not.toBe(403);

      // No self-service "my recordings" route exists for a MODERATOR actor
      // (investigation.recording.view is not in the MODERATOR permission set —
      // confirmed by prior research). Use the admin-only listing route instead,
      // passing the moderator's own id — this still proves the recording was
      // created and is retrievable without a scope bypass; it does not itself
      // exercise region-scope enforcement on the read path (Admin is
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
          r.roomId === roomIds.blr &&
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
    const BLR_REPORT_ID = '00000000-0000-4000-8000-0000000012b1';
    const CHN_REPORT_ID = '00000000-0000-4000-8000-0000000012c1';

    const dashboard = async () => {
      const res = await request(app.getHttpServer())
        .get('/api/mobile/workforce/me/dashboard')
        .set('Authorization', `Bearer ${moderatorToken}`);
      expect(res.status).toBe(200);
      return res.body.data;
    };

    it('12. moderator dashboard reflects only Bengaluru + Vijayawada, never Chennai', async () => {
      const data = await dashboard();
      const roomIdsInDashboard = (data.assignedAudioRooms ?? []).map((r: any) => r.id);
      expect(roomIdsInDashboard).not.toContain(roomIds.chn);
      // The list is scoped by the ROOM's own `region` column, so the in-scope
      // Bengaluru room must actually be present — "not Chennai" alone is also
      // satisfied by an empty list.
      expect(roomIdsInDashboard).toContain(roomIds.blr);
    });

    it("12b. assignedReportsCount counts the in-scope room's report and not the out-of-scope room's", async () => {
      // Seeded directly via Prisma, mirroring scenario 10's
      // ModerationActionApproval shortcut. RoomReport's required columns per
      // prisma/schema/audio_rooms_moderation.prisma are roomId, reporterId,
      // targetUserId and reason; the rest default (status defaults to PENDING).
      // reporterId/targetUserId carry no declared FK relation, so any
      // well-formed UUID works — real seeded ids are used for realism.
      await prisma.roomReport.deleteMany({
        where: { id: { in: [BLR_REPORT_ID, CHN_REPORT_ID] } },
      });

      const before = await dashboard();
      const baseline = before.assignedReportsCount;
      expect(typeof baseline).toBe('number');

      await prisma.roomReport.createMany({
        data: [
          {
            id: BLR_REPORT_ID,
            roomId: roomIds.blr,
            reporterId: adminId,
            targetUserId: PLACEHOLDER_TARGET_USER_ID,
            reason: 'SPAM',
            description: 'e2e scenario 12 — in-scope (Bengaluru)',
          },
          {
            id: CHN_REPORT_ID,
            roomId: roomIds.chn,
            reporterId: adminId,
            targetUserId: PLACEHOLDER_TARGET_USER_ID,
            reason: 'SPAM',
            description: 'e2e scenario 12 — out-of-scope (Chennai)',
          },
        ],
      });

      const after = await dashboard();
      // Exactly one of the two new reports may be counted: the Bengaluru one.
      // A +2 delta would mean the Chennai report leaked past region scope; a
      // +0 delta would mean the in-scope report was wrongly excluded.
      expect(after.assignedReportsCount).toBe(baseline + 1);

      await prisma.roomReport.deleteMany({
        where: { id: { in: [BLR_REPORT_ID, CHN_REPORT_ID] } },
      });
    });
  });
});
