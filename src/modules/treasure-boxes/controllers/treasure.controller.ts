import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import {
  AuditLogAction,
  RequirePermissions,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import {
  RocketService,
  TreasureAuditService,
  TreasureBoxService,
  TreasureConfigurationService,
  TreasureHistoryService,
  TreasureResetService,
  TreasureService,
} from '../services';

@ApiTags('Treasure Boxes & Enterprise Treasure Engine')
@ApiBearerAuth()
@Controller('rooms')
export class TreasureController {
  constructor(
    private readonly treasure: TreasureService,
    private readonly rocket: RocketService,
    private readonly boxService: TreasureBoxService,
    private readonly historyService: TreasureHistoryService,
    private readonly auditService: TreasureAuditService,
    private readonly configService: TreasureConfigurationService,
    private readonly resetService: TreasureResetService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/treasure/start')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Start a treasure session (owner/admin)' })
  start(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.treasure.startSession(this.actor(user), id);
  }

  @Post(':id/treasure/cancel')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Cancel the active treasure session (owner/admin)' })
  async cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.treasure.cancelSession(this.actor(user), id);
    return { cancelled: true };
  }

  @Get(':id/treasure/status')
  @ApiOperation({ summary: 'Live treasure session status (boxes + progress)' })
  @ApiResponse({ status: 200, description: 'Treasure box status' })
  status(@Param('id', ParseUuidPipe) id: string) {
    return this.boxService.getRoomStatus(id);
  }

  @Get(':id/treasure/progress')
  @ApiOperation({ summary: 'Current treasure box progress detail' })
  @ApiResponse({ status: 200, description: 'Progress breakdown' })
  progress(@Param('id', ParseUuidPipe) id: string) {
    return this.boxService.getRoomStatus(id);
  }

  @Get(':id/treasure/history')
  @ApiOperation({ summary: 'Past treasure sessions in the room' })
  @ApiResponse({ status: 200, description: 'Session history' })
  history(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.historyService.getRoomSessionHistory(id, { page: q.page, limit: q.limit });
  }

  @Get(':id/treasure/rewards')
  @ApiOperation({ summary: 'Treasure reward distribution log for the room' })
  @ApiResponse({ status: 200, description: 'Reward history' })
  rewards(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.historyService.getRoomRewardHistory(id, { page: q.page, limit: q.limit });
  }

  @Get(':id/treasure/winners')
  @ApiOperation({ summary: 'Recent treasure box winners in the room' })
  @ApiResponse({ status: 200, description: 'Winners list' })
  winners(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.historyService.getRoomRewardHistory(id, { page: q.page, limit: q.limit });
  }

  @Get(':id/treasure/configuration')
  @ApiOperation({ summary: 'Treasure Box 5-level configuration thresholds & pool settings' })
  @ApiResponse({ status: 200, description: 'Configuration details' })
  configuration() {
    return this.configService.getAllLevelConfigs();
  }

  @Get(':id/treasure/reward-config')
  @ApiOperation({
    summary: 'Configured prize list per box (rank → reward), with resolved asset art',
  })
  @ApiResponse({ status: 200, description: 'Per-level configured rewards' })
  rewardConfig() {
    return this.configService.getAllLevelRewardViews();
  }

  @Get(':id/treasure/audit')
  @ApiOperation({ summary: 'Treasure audit event log' })
  @ApiResponse({ status: 200, description: 'Audit log' })
  audit(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.auditService.getAuditLogs(id, q.page, q.limit);
  }

  @Post(':id/treasure/reset')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RbacPermissionsGuard)
  @RequirePermissions('treasure.configuration.manage')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('TREASURE_RESET', 'treasure_session')
  @ApiOperation({ summary: 'Manual reset of daily room treasure cycle (admin/owner)' })
  @ApiResponse({ status: 200, description: 'Reset result' })
  reset(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.resetService.resetRoomTreasure(id, user.id);
  }

  @Get(':id/treasure/champions')
  @ApiOperation({
    summary: 'Treasure Champions - Top Contributors history for all completed boxes',
  })
  champions(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.treasure.champions(id, user.id);
  }

  @Get(':id/rocket/history')
  @ApiOperation({ summary: 'Rocket events in the room' })
  rocketHistory(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.rocket.history(id, { skip: q.skip, limit: q.limit, page: q.page });
  }
}
