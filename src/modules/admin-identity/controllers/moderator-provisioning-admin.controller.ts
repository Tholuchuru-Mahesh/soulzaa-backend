import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { RequestMeta } from 'src/common/decorators/request-meta.decorator';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { CreateModeratorDto } from '../dto/create-moderator.dto';
import { SetAdminStatusDto } from '../dto/set-admin-status.dto';
import { SetModeratorStatesDto } from '../dto/set-moderator-states.dto';
import { ModeratorProvisioningService } from '../services/moderator-provisioning.service';

/**
 * Moderator account provisioning — Admin and Super Admin only.
 *
 * Gated on `admin.identity.manage` permission. Admins can create and manage
 * anonymous Moderator accounts that are hidden from all public surfaces.
 *
 * Filename ends in `-admin.controller.ts` so the RBAC matrix test picks it up.
 */
@ApiTags('Admin Identity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('admin.identity.manage')
@Controller('admin-identity/moderators')
export class ModeratorProvisioningAdminController {
  constructor(private readonly service: ModeratorProvisioningService) {}

  @ApiOperation({ summary: 'Provision a hidden Moderator account (Admin only)' })
  @ApiResponse({
    status: 201,
    description: 'Moderator account created and hidden from public surfaces',
  })
  @ApiResponse({ status: 403, description: 'Actor is not Admin or Super Admin' })
  @Post()
  create(
    @CurrentUser('id') actorId: string,
    @Body() dto: CreateModeratorDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.service.createModerator(actorId, dto, {
      ip: meta.ip,
      userAgent: meta.userAgent,
    } as never);
  }

  @ApiOperation({ summary: 'List Moderator accounts (Admin only)' })
  @ApiResponse({ status: 200, description: 'Moderator roster. Identities are hidden from public.' })
  @Get()
  list(@CurrentUser('id') actorId: string) {
    return this.service.listModerators(actorId);
  }

  @ApiOperation({ summary: 'Update Moderator account status (Admin only)' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @CurrentUser('id') actorId: string,
    @Param('id') targetId: string,
    @Body() dto: SetAdminStatusDto,
  ) {
    return this.service.setModeratorStatus(actorId, targetId, dto.status);
  }

  @ApiOperation({ summary: "Get a Moderator's current operational states (Admin only)" })
  @ApiResponse({ status: 200, description: 'Current RoleScope state ids' })
  @Get(':id/states')
  getStates(@CurrentUser('id') actorId: string, @Param('id') targetId: string) {
    return this.service.getModeratorStates(actorId, targetId);
  }

  @ApiOperation({ summary: "Replace a Moderator's operational states (Admin only)" })
  @ApiResponse({ status: 200, description: 'States reconciled' })
  @Put(':id/states')
  setStates(
    @CurrentUser('id') actorId: string,
    @Param('id') targetId: string,
    @Body() dto: SetModeratorStatesDto,
  ) {
    return this.service.setModeratorStates(targetId, dto.stateIds, actorId);
  }
}
