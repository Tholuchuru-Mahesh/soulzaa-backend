import { Module } from '@nestjs/common';

/**
 * Notification domain — push/in-app notifications and preferences.
 *
 * Phase 0 placeholder — no controllers/providers yet. When implemented, this
 * module owns its Prisma models (its file under prisma/schema/), its DTOs, and
 * exposes a public service interface (interfaces/); other domains depend only on
 * that interface or communicate via the EVENT_BUS — never on its internals.
 */
@Module({})
export class NotificationModule {}
