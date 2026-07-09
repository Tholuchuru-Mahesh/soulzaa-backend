import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RocketConfigDto, TreasureConfigDto } from '../dto/treasure.dto';
import { TreasureAdminService } from '../services/treasure-admin.service';

/**
 * Platform-admin configuration for treasure boxes and rocket events (base
 * `admin/treasure`). Restricted to ADMIN/SUPER_ADMIN. Box configs are keyed by
 * level (1..5); rocket configs by trigger gift. Upserts are idempotent per key.
 */
@ApiTags('treasure-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/treasure')
export class TreasureAdminController {
  constructor(private readonly admin: TreasureAdminService) {}

  @Get('configs')
  @ApiOperation({ summary: 'List the 5 treasure box level configs' })
  listConfigs() {
    return this.admin.listTreasureConfigs();
  }

  @Put('configs')
  @ApiOperation({ summary: 'Create/replace a treasure box level config' })
  upsertConfig(@CurrentUser('id') adminId: string, @Body() dto: TreasureConfigDto) {
    return this.admin.upsertTreasureConfig(adminId, dto);
  }

  @Get('rocket-configs')
  @ApiOperation({ summary: 'List rocket configs (by trigger gift)' })
  listRocketConfigs() {
    return this.admin.listRocketConfigs();
  }

  @Put('rocket-configs')
  @ApiOperation({ summary: 'Create/replace a rocket config' })
  upsertRocketConfig(@CurrentUser('id') adminId: string, @Body() dto: RocketConfigDto) {
    return this.admin.upsertRocketConfig(adminId, dto);
  }
}
