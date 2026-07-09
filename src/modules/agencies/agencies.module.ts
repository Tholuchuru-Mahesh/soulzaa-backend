import { Module } from '@nestjs/common';

/**
 * Agencies domain — agencies, hosts, commissions, performance.
 *
 * Phase 0 placeholder — no controllers/providers yet. When implemented, this
 * module owns its Prisma models (its file under prisma/schema/), its DTOs, and
 * communicates with other domains only via the EVENT_BUS.
 */
@Module({})
export class AgenciesModule {}
