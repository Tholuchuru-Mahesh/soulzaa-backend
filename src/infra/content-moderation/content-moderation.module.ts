import { Global, Module } from '@nestjs/common';
import { BlockedWordRepository } from './blocked-word.repository';
import { ChatBlockedWordSeeder } from './blocked-word.seeder.service';
import { BlockedWordService } from './blocked-word.service';

/**
 * Platform-wide content moderation. The `chat_blocked_words` dictionary is global
 * — no room or room-type scoping — so the engine belongs here rather than being
 * owned by one room domain. Audio Rooms (AR-4) and Video Rooms (VR-9) both
 * consume it; neither owns it, and no cross-module dependency edge is created.
 */
@Global()
@Module({
  providers: [BlockedWordRepository, BlockedWordService, ChatBlockedWordSeeder],
  exports: [BlockedWordRepository, BlockedWordService],
})
export class ContentModerationModule {}
