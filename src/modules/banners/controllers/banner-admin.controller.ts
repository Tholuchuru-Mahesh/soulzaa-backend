import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards, UseInterceptors } from '@nestjs/common';
import { BannerService } from '../services/banner.service';
import { CreateBannerDto, UpdateBannerDto, ReorderBannersDto } from '../dto/banner.dto';
import {
  AuditLogAction,
  CurrentUser,
  RequirePermissions,
  RequireRoles,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';

@Controller('admin/banners')
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@UseInterceptors(AuditLogInterceptor)
export class BannerAdminController {
  constructor(private readonly service: BannerService) {}

  @Get()
  @RequirePermissions('banners.manage')
  list() {
    return this.service.list();
  }

  @Post()
  @RequirePermissions('banners.manage')
  @AuditLogAction('BANNER_CREATED', 'banner')
  create(@CurrentUser('id') actorId: string, @Body() dto: CreateBannerDto) {
    return this.service.create(actorId, dto);
  }

  @Put(':id')
  @RequirePermissions('banners.manage')
  @AuditLogAction('BANNER_UPDATED', 'banner')
  update(@Param('id') id: string, @Body() dto: UpdateBannerDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/toggle')
  @RequirePermissions('banners.manage')
  @AuditLogAction('BANNER_TOGGLED', 'banner')
  toggle(@Param('id') id: string, @Body('isActive') isActive: boolean) {
    return this.service.toggle(id, isActive);
  }

  @Patch('reorder')
  @RequirePermissions('banners.manage')
  @AuditLogAction('BANNER_REORDERED', 'banner')
  reorder(@Body() dto: ReorderBannersDto) {
    return this.service.reorder(dto.orderedIds);
  }

  @Delete(':id')
  @RequirePermissions('banners.manage')
  @AuditLogAction('BANNER_DELETED', 'banner')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
