import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ModeratorNotificationService } from '../services/moderator-notification.service';

/**
 * Task 27 & 33 — Admin + Manager + Official moderator notification endpoints.
 *
 * POST /admin/policy-update           Admin → MODERATOR_POLICY_UPDATE broadcast
 * POST /admin/system-announcement     Admin → MODERATOR_SYSTEM_ANNOUNCEMENT broadcast
 * POST /moderator/emergency-request   Official/Manager → MODERATOR_EMERGENCY_REQUEST
 * POST /moderator/official-message    Official → MODERATOR_OFFICIAL_MESSAGE
 * POST /moderator/manager-instruction Manager → MODERATOR_MANAGER_INSTRUCTION
 */
@ApiTags('Moderator Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller()
export class ModeratorNotificationController {
  constructor(private readonly notificationService: ModeratorNotificationService) {}

  // ---- Admin broadcasts ----

  @Post('admin/policy-update')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('announcement.manage')
  @ApiOperation({ summary: 'Admin: broadcast a policy update to all active moderators' })
  async broadcastPolicyUpdate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: { title: string; body: string },
  ) {
    await this.notificationService.broadcastPolicyUpdate(user.id, dto.title, dto.body);
    return { ok: true };
  }

  @Post('admin/system-announcement')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('announcement.manage')
  @ApiOperation({ summary: 'Admin: broadcast a system announcement to all active moderators' })
  async broadcastSystemAnnouncement(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: { title: string; body: string },
  ) {
    await this.notificationService.broadcastSystemAnnouncement(user.id, dto.title, dto.body);
    return { ok: true };
  }

  // ---- Official/Manager targeted sends ----

  @Post('moderator/emergency-request')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('mobile.workforce.view')
  @ApiOperation({ summary: 'Official/Manager: send an emergency request to specific moderators' })
  async sendEmergencyRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: { moderatorIds: string[]; message: string; regionId?: string },
  ) {
    await this.notificationService.sendEmergencyRequest(dto.moderatorIds, user.id, dto.message, dto.regionId);
    return { ok: true };
  }

  @Post('moderator/official-message')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('mobile.workforce.view')
  @ApiOperation({ summary: 'Official: send an official message to specific moderators' })
  async sendOfficialMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: { moderatorIds: string[]; title: string; message: string },
  ) {
    await this.notificationService.sendOfficialMessage(dto.moderatorIds, user.id, dto.title, dto.message);
    return { ok: true };
  }

  @Post('moderator/manager-instruction')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('mobile.workforce.view')
  @ApiOperation({ summary: 'Manager: send an instruction to specific moderators' })
  async sendManagerInstruction(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: { moderatorIds: string[]; title: string; instruction: string; priority?: 'NORMAL' | 'URGENT' },
  ) {
    await this.notificationService.sendManagerInstruction(
      dto.moderatorIds,
      user.id,
      dto.title,
      dto.instruction,
      dto.priority,
    );
    return { ok: true };
  }
}
