// src/modules/platform-moderation/controllers/platform-moderation-admin.controller.ts
import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { ListPlatformBansDto } from '../dto/list-platform-bans.dto';
import { PlatformModerationAuditService } from '../services/platform-moderation-audit.service';
import { PlatformBanService } from '../services/platform-ban.service';

@ApiTags('admin-moderation')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/moderation')
export class PlatformModerationAdminController {
  constructor(
    private readonly bans: PlatformBanService,
    private readonly audit: PlatformModerationAuditService,
  ) {}

  @Get('bans')
  async listBans(@Query() q: ListPlatformBansDto) {
    const skip = q.skip ?? Math.max(0, ((q.page ?? 1) - 1) * (q.limit ?? 20));
    const limit = q.limit ?? 20;
    const [rows, total] = await this.bans.list(
      { status: q.status, targetUserId: q.targetUserId },
      skip,
      limit,
    );
    return buildPaginated(rows, total, q.page ?? 1, limit);
  }

  @Post('bans/:id/lift')
  lift(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.bans.unbanUser(user.id, id);
  }

  @Get('audit-log')
  async auditLog(@Query() q: ListPlatformBansDto) {
    const skip = q.skip ?? Math.max(0, ((q.page ?? 1) - 1) * (q.limit ?? 20));
    const limit = q.limit ?? 20;
    const [rows, total] = await this.audit.list({ targetUserId: q.targetUserId }, skip, limit);
    return buildPaginated(rows, total, q.page ?? 1, limit);
  }
}
