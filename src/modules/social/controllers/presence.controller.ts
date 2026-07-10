import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { PresenceQueryDto } from '../dto/presence-query.dto';
import { SocialPresenceService } from '../services/social-presence.service';

/**
 * Presence read surface. Returns online/rich-status/last-seen for a batch of
 * users (max 100), each field privacy-gated for the caller.
 */
@ApiTags('social')
@ApiBearerAuth()
@Controller('social/presence')
export class PresenceController {
  constructor(private readonly presence: SocialPresenceService) {}

  @Get()
  @ApiOperation({ summary: 'Batch presence + last-seen for a set of users' })
  getMany(@CurrentUser('id') viewerId: string, @Query() q: PresenceQueryDto) {
    return this.presence.getMany(viewerId, q.userIds);
  }
}
