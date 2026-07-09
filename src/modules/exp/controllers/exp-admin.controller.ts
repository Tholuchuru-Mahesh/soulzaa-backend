import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ExpSource } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { AwardExpDto, LevelConfigDto, RoomLevelConfigDto } from '../dto/exp.dto';
import { ExpAdminService } from '../services/exp-admin.service';
import { ExpService } from '../services/exp.service';

/**
 * Platform-admin EXP configuration + manual awards (base `admin/exp`).
 * Restricted to ADMIN/SUPER_ADMIN.
 */
@ApiTags('exp-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/exp')
export class ExpAdminController {
  constructor(
    private readonly admin: ExpAdminService,
    private readonly exp: ExpService,
  ) {}

  @Get('levels')
  @ApiOperation({ summary: 'List user level configs' })
  levels() {
    return this.admin.listLevels();
  }

  @Put('levels')
  @ApiOperation({ summary: 'Create/replace a user level config' })
  upsertLevel(@CurrentUser('id') adminId: string, @Body() dto: LevelConfigDto) {
    return this.admin.upsertLevel(adminId, dto);
  }

  @Get('room-levels')
  @ApiOperation({ summary: 'List room level configs' })
  roomLevels() {
    return this.admin.listRoomLevels();
  }

  @Put('room-levels')
  @ApiOperation({ summary: 'Create/replace a room level config' })
  upsertRoomLevel(@CurrentUser('id') adminId: string, @Body() dto: RoomLevelConfigDto) {
    return this.admin.upsertRoomLevel(adminId, dto);
  }

  @Post('award')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually award EXP to a user' })
  award(@Body() dto: AwardExpDto) {
    return this.exp.award({
      userId: dto.userId,
      amount: dto.amount,
      source: ExpSource.ADMIN,
      idempotencyKey: `admin-exp:${randomUUID()}`,
    });
  }
}
