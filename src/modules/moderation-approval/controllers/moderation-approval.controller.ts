import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ModerationApprovalRoomType } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { DecideApprovalDto } from '../dto/decide-approval.dto';
import { ModerationApprovalService } from '../services/moderation-approval.service';

@ApiTags('moderation-approvals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('moderation/approvals')
export class ModerationApprovalController {
  constructor(private readonly service: ModerationApprovalService) {}

  @Get()
  @RequirePermissions('moderation.action.approve')
  @ApiOperation({ summary: 'List pending moderator-proposed ban approvals' })
  listPending(@Query('roomType') roomType?: ModerationApprovalRoomType) {
    return this.service.listPending(roomType);
  }

  @Get(':id')
  @RequirePermissions('moderation.action.approve')
  @ApiOperation({ summary: 'Get a single approval request by id' })
  getOne(@Param('id', ParseUuidPipe) id: string) {
    return this.service.getById(id);
  }

  @Post(':id/decide')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('moderation.action.approve')
  @ApiOperation({ summary: 'Approve or reject a moderator-proposed ban' })
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: DecideApprovalDto,
  ) {
    return this.service.decide(id, user.id, dto.decision, dto.note);
  }
}
