import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { RequireRoles } from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import {
  AgencyDistributionQueryDto,
  AgencyTaskQueryDto,
  DistributeRewardDto,
} from '../dto/agency-operations.dto';
import { AgencyRewardService } from '../services/agency-reward.service';
import { AgencyTaskService } from '../services/agency-task.service';

/**
 * The agency's own tasks and reward shelf.
 *
 * Scoped to the JWT caller throughout. An agency cannot create its own tasks —
 * Officials set them — and cannot allocate its own stock, which is why the only
 * write here is distributing a reward it already holds.
 */
@ApiTags('agency-operations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard)
@RequireRoles('AGENCY')
@Controller('agencies/me')
export class AgencyOperationsController {
  constructor(
    private readonly tasks: AgencyTaskService,
    private readonly rewards: AgencyRewardService,
  ) {}

  @Get('tasks')
  @ApiOperation({ summary: 'Tasks set for the calling agency, soonest deadline first' })
  listTasks(@CurrentUser() user: AuthenticatedUser, @Query() query: AgencyTaskQueryDto) {
    return this.tasks.list(user.id, { status: query.status, limit: query.limit });
  }

  @Get('tasks/summary')
  @ApiOperation({ summary: 'Active / completed / expired counts' })
  // Before `tasks/:taskId`, so the literal segment wins.
  taskSummary(@CurrentUser() user: AuthenticatedUser) {
    return this.tasks.summary(user.id);
  }

  @Get('tasks/:taskId')
  @ApiOperation({ summary: 'One task with its measured progress' })
  @ApiResponse({ status: 404, description: 'Not this agency’s task' })
  getTask(@CurrentUser() user: AuthenticatedUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.tasks.get(user.id, taskId);
  }

  @Get('rewards/inventory')
  @ApiOperation({ summary: 'Reward stock the agency holds' })
  inventory(@CurrentUser() user: AuthenticatedUser) {
    return this.rewards.listInventory(user.id);
  }

  @Get('rewards/stats')
  @ApiOperation({ summary: 'How many rewards this agency has sent' })
  rewardStats(@CurrentUser() user: AuthenticatedUser) {
    return this.rewards.getStats(user.id);
  }

  @Get('rewards/distributions')
  @ApiOperation({ summary: 'Rewards the agency has sent, newest first' })
  distributions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AgencyDistributionQueryDto,
  ) {
    return this.rewards.listDistributions(user.id, query);
  }

  @Post('rewards/distribute')
  @ApiOperation({ summary: 'Send a reward from the shelf to one of the agency’s members' })
  @ApiResponse({ status: 404, description: 'Reward not held, or recipient not a member' })
  distribute(@CurrentUser() user: AuthenticatedUser, @Body() dto: DistributeRewardDto) {
    return this.rewards.distribute(user.id, {
      inventoryId: dto.inventoryId,
      recipientId: dto.recipientId,
      quantity: dto.quantity,
      kind: dto.kind,
      note: dto.note,
      idempotencyKey: dto.idempotencyKey,
    });
  }
}
