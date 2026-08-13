import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ModeratorWarningLevel, ModeratorWarningStatus } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { ModeratorWarningService } from '../services/moderator-warning.service';

class IssueWarningDto {
  level!: ModeratorWarningLevel;
  reason!: string;
  description?: string;
}

class ResolveWarningDto {
  resolution?: string;
}

@ApiTags('moderator-warning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('admin/moderator-warnings')
export class ModeratorWarningController {
  constructor(private readonly service: ModeratorWarningService) {}

  @Post(':moderatorId')
  @RequirePermissions('moderator.warning.issue')
  @ApiOperation({ summary: 'Issue an internal warning to a moderator (Manager/Admin)' })
  issue(
    @Param('moderatorId', ParseUuidPipe) moderatorId: string,
    @Body() dto: IssueWarningDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.issueWarning({
      moderatorId,
      issuedBy: actor.id,
      level: dto.level,
      reason: dto.reason,
      description: dto.description,
    });
  }

  @Get(':moderatorId')
  @RequirePermissions('moderator.warning.view')
  @ApiOperation({ summary: "List all warnings for a moderator (Manager/Admin)" })
  listForModerator(
    @Param('moderatorId', ParseUuidPipe) moderatorId: string,
    @Query('status') status?: ModeratorWarningStatus,
    @Query('level') level?: ModeratorWarningLevel,
  ) {
    return this.service.getWarnings(moderatorId, { status, level });
  }

  @Get()
  @RequirePermissions('moderator.warning.view')
  @ApiOperation({ summary: 'List all warnings across all moderators (Admin only)' })
  listAll(
    @Query('status') status?: ModeratorWarningStatus,
    @Query('level') level?: ModeratorWarningLevel,
  ) {
    return this.service.listAll({ status, level });
  }

  @Put(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('moderator.warning.resolve')
  @ApiOperation({ summary: 'Resolve a warning and restore Moderator access (Admin only)' })
  resolve(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ResolveWarningDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.resolveWarning(id, actor.id, dto.resolution);
  }

  @Put(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('moderator.warning.review')
  @ApiOperation({ summary: 'Country Manager reviews a Level-2 moderator warning' })
  review(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: { approved: boolean; note?: string },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.reviewWarning(id, actor.id, dto.approved, dto.note);
  }
}

/** Moderator reads their own warnings */
@ApiTags('moderator-warning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('moderator/my-warnings')
export class MyWarningsController {
  constructor(private readonly service: ModeratorWarningService) {}

  @Get()
  @RequirePermissions('moderator.warning.view.self')
  @ApiOperation({ summary: "Moderator views their own warning records" })
  myWarnings(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getWarnings(user.id);
  }
}
