import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { RequestMeta } from 'src/common/decorators/request-meta.decorator';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { CreateAdminDto } from '../dto/create-admin.dto';
import { SetAdminStatusDto } from '../dto/set-admin-status.dto';
import { AdminProvisioningService } from '../services/admin-provisioning.service';

/**
 * Admin account provisioning — Super Admin only.
 *
 * Gated on `admin.provision`, which `rbac-role-matrix.spec.ts` asserts is in the
 * SUPER_ADMIN_ONLY set, so an ADMIN can never reach these routes even if someone
 * later widens the role's permission list by mistake.
 *
 * Filename ends in `-admin.controller.ts` deliberately: that is how the matrix
 * test discovers administrative controllers.
 */
@ApiTags('Admin Identity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('admin.provision')
@Controller('admin-identity/admins')
export class AdminProvisioningAdminController {
  constructor(private readonly service: AdminProvisioningService) {}

  @ApiOperation({ summary: 'Create a hidden Admin account (Super Admin only)' })
  @ApiResponse({ status: 201, description: 'Admin created and hidden from all public surfaces' })
  @ApiResponse({ status: 403, description: 'Actor is not Super Admin' })
  @Post()
  create(
    @CurrentUser('id') actorId: string,
    @Body() dto: CreateAdminDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.service.createAdmin(actorId, dto, {
      ip: meta.ip,
      userAgent: meta.userAgent,
    } as never);
  }

  @ApiOperation({ summary: 'List Admin accounts (Super Admin only)' })
  @ApiResponse({ status: 200, description: 'Admin roster. Super Admins are never listed.' })
  @Get()
  list(@CurrentUser('id') actorId: string) {
    return this.service.listAdmins(actorId);
  }

  @ApiOperation({ summary: 'Suspend or restore an Admin account (Super Admin only)' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @ApiResponse({ status: 403, description: 'Target is a Super Admin, or actor is not Super Admin' })
  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @CurrentUser('id') actorId: string,
    @Param('id') targetId: string,
    @Body() dto: SetAdminStatusDto,
  ) {
    return this.service.setStatus(actorId, targetId, dto.status);
  }
}
