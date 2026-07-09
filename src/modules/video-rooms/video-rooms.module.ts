import { Module } from '@nestjs/common';

/**
 * Video Rooms domain — multi-seat video, viewers, PK.
 *
 * Phase 0 placeholder — no controllers/providers yet. When implemented, this
 * module owns its Prisma models (its file under prisma/schema/), its DTOs, and
 * communicates with other domains only via the EVENT_BUS.
 */
@Module({})
export class VideoRoomsModule {}
