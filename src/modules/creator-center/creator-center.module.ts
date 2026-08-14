import { Module } from '@nestjs/common';
import { AnalyticsModule } from 'src/modules/analytics/analytics.module';
import { MobileWorkforceModule } from 'src/modules/mobile-workforce/mobile-workforce.module';
import { ContentRequestController } from './controllers/content-request.controller';
import { CreatorCenterController } from './controllers/creator-center.controller';
import { ActiveAccountGuard } from './guards/active-account.guard';
import { ContentRequestService } from './services/content-request.service';
import { CreatorCenterService } from './services/creator-center.service';

/**
 * Creator Center — the Profile page's 8-tile creator surface. A pure
 * composition module: it owns no financial or room-lifecycle data of its own,
 * only creator-scoped read queries that delegate to the audio-rooms, gifts,
 * social and analytics domains (AUDIO_ROOMS_SERVICE / GIFTS_SERVICE /
 * SOCIAL_SERVICE / USERS_SERVICE are `@Global()` already; only AnalyticsModule
 * needs an explicit import here).
 *
 * Also hosts the Official Portal's Content Requests surface (content review
 * requests raised by Officials against user-generated content in their
 * territory).
 */
@Module({
  imports: [AnalyticsModule, MobileWorkforceModule],
  controllers: [CreatorCenterController, ContentRequestController],
  providers: [CreatorCenterService, ContentRequestService, ActiveAccountGuard],
})
export class CreatorCenterModule {}
