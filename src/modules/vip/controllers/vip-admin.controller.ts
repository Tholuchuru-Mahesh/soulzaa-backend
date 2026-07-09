import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { VipConfigDto } from '../dto/vip.dto';
import { VipAdminService } from '../services/vip-admin.service';

/**
 * Platform-admin VIP tier configuration (base `admin/vip`). Restricted to
 * ADMIN/SUPER_ADMIN. Configs are keyed by tier; upserts are idempotent.
 */
@ApiTags('vip-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/vip')
export class VipAdminController {
  constructor(private readonly admin: VipAdminService) {}

  @Get('configs')
  @ApiOperation({ summary: 'List VIP tier configs' })
  list() {
    return this.admin.listConfigs();
  }

  @Put('configs')
  @ApiOperation({ summary: 'Create/replace a VIP tier config' })
  upsert(@CurrentUser('id') adminId: string, @Body() dto: VipConfigDto) {
    return this.admin.upsertConfig(adminId, dto);
  }
}
