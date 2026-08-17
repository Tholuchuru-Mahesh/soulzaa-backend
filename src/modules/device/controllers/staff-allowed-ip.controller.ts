import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { StaffIpAllowlistService } from '../services/staff-ip-allowlist.service';

class AddStaffIpDto {
  @IsString()
  @IsNotEmpty()
  cidr!: string;

  @IsOptional()
  @IsString()
  label?: string;
}

@ApiTags('admin-staff-ip')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('admin/staff')
export class StaffAllowedIpController {
  constructor(private readonly service: StaffIpAllowlistService) {}

  @Post(':userId/allowed-ips')
  @RequirePermissions('admin.identity.manage')
  @ApiOperation({ summary: 'Add an approved IP/CIDR for a staff account (Admin/Super Admin only)' })
  addIp(
    @Param('userId', ParseUuidPipe) userId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddStaffIpDto,
  ) {
    return this.service.addIp(userId, dto.cidr, dto.label, user.id);
  }

  @Delete(':userId/allowed-ips/:ipId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('admin.identity.manage')
  @ApiOperation({
    summary: 'Remove an approved IP/CIDR from a staff account (Admin/Super Admin only)',
  })
  removeIp(@Param('ipId', ParseUuidPipe) ipId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.removeIp(ipId, user.id);
  }

  @Get(':userId/allowed-ips')
  @RequirePermissions('admin.identity.manage')
  @ApiOperation({ summary: 'List approved IPs/CIDRs for a staff account (Admin/Super Admin only)' })
  listIps(@Param('userId', ParseUuidPipe) userId: string) {
    return this.service.listIps(userId);
  }
}
