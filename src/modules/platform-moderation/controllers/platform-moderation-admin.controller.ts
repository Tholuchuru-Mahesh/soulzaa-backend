// src/modules/platform-moderation/controllers/platform-moderation-admin.controller.ts
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { ExtendBanDto } from '../dto/extend-ban.dto';
import { ListPlatformBansDto } from '../dto/list-platform-bans.dto';
import { ListBroadBansDto } from '../dto/list-broad-bans.dto';
import { PlatformModerationAuditService } from '../services/platform-moderation-audit.service';
import { PlatformBanService } from '../services/platform-ban.service';
import { BroadBanService } from '../services/broad-ban.service';

@ApiTags('admin-moderation')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/moderation')
export class PlatformModerationAdminController {
  constructor(
    private readonly bans: PlatformBanService,
    private readonly audit: PlatformModerationAuditService,
    private readonly broadBans: BroadBanService,
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

  @Post('bans/:id/extend')
  extendBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ExtendBanDto,
  ) {
    return this.bans.extendBan(user.id, id, dto.additionalHours);
  }

  @Get('broad-bans')
  async listBroadBans(@Query() q: ListBroadBansDto) {
    const skip = q.skip ?? Math.max(0, ((q.page ?? 1) - 1) * (q.limit ?? 20));
    const limit = q.limit ?? 20;
    const [rows, total] = await this.broadBans.list(
      { status: q.status, ownerId: q.ownerId },
      skip,
      limit,
    );
    return buildPaginated(rows, total, q.page ?? 1, limit);
  }

  @Post('broad-bans/:id/revoke')
  revokeBroadBan(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.broadBans.liftBroadBan(user.id, id);
  }

  @Post('broad-bans/:id/extend')
  extendBroadBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ExtendBanDto,
  ) {
    return this.broadBans.extendBroadBan(user.id, id, dto.additionalHours);
  }

  @Get('audit-log')
  async auditLog(@Query() q: ListPlatformBansDto) {
    const skip = q.skip ?? Math.max(0, ((q.page ?? 1) - 1) * (q.limit ?? 20));
    const limit = q.limit ?? 20;
    const [rows, total] = await this.audit.list({ targetUserId: q.targetUserId }, skip, limit);
    return buildPaginated(rows, total, q.page ?? 1, limit);
  }
}
