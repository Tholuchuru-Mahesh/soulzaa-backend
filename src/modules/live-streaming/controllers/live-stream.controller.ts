import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LiveStreamStatus } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { ShiftActiveGuard } from 'src/modules/moderator-shift/guards/shift-active.guard';
import { SuspendedGuard } from 'src/modules/moderator-warning/guards/suspended.guard';
import { LiveStreamService } from '../services/live-stream.service';

class CreateStreamDto {
  title?: string;
  description?: string;
}

class ModerateStreamUserDto {
  targetUserId!: string;
  action!: 'WARN' | 'MUTE' | 'KICK' | 'BAN';
  reason?: string;
}

@ApiTags('live-streaming')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('live-streams')
export class LiveStreamController {
  constructor(private readonly service: LiveStreamService) {}

  @Post()
  @RequirePermissions('live.stream.create')
  @ApiOperation({ summary: 'Host creates a new live stream' })
  createStream(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateStreamDto) {
    return this.service.createStream({
      hostId: user.id,
      title: dto.title,
      description: dto.description,
    });
  }

  @Get()
  @RequirePermissions('live.stream.view')
  @ApiOperation({ summary: 'List active live streams' })
  listStreams(
    @Query('status') status?: LiveStreamStatus,
    @Query('regionId') regionId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listStreams(
      { status: status ?? LiveStreamStatus.ACTIVE, regionId },
      Number(page ?? 1),
      Number(limit ?? 20),
    );
  }

  @Get(':id')
  @RequirePermissions('live.stream.view')
  @ApiOperation({ summary: 'Get live stream details' })
  getStream(@Param('id', ParseUuidPipe) id: string) {
    return this.service.getStream(id);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.manage')
  @ApiOperation({ summary: 'End a live stream (Host or Admin)' })
  endStream(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.endStream(id, user.id);
  }

  @Post(':id/moderation')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({ summary: 'Perform moderation action in live stream (Warn, Mute, Kick, Ban)' })
  moderateUser(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ModerateStreamUserDto,
  ) {
    return this.service.moderateUser({
      streamId: id,
      moderatorId: user.id,
      targetUserId: dto.targetUserId,
      action: dto.action,
      reason: dto.reason,
    });
  }

  @Get(':id/moderation/actions')
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({
    summary: 'Get moderation action trail for a live stream (optionally filter by target user)',
  })
  getActions(@Param('id', ParseUuidPipe) id: string, @Query('targetUserId') targetUserId?: string) {
    return this.service.getStreamActions(id, targetUserId);
  }

  @Post(':id/moderation/escalate')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({ summary: 'Escalate critical violation in live stream to managers/admins' })
  escalate(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: { targetUserId: string; reason: string },
  ) {
    return this.service.escalateViolation(id, user.id, dto.targetUserId, dto.reason);
  }

  // ======================= Realtime Presence (Redis-only, Anonymous Moderator) =======================

  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.view')
  @ApiOperation({
    summary: 'Join live stream viewer presence (ephemeral, anonymous for moderators)',
  })
  joinStream(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.joinStream(id, user);
  }

  @Post(':id/leave')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.view')
  @ApiOperation({ summary: 'Leave live stream viewer presence' })
  leaveStream(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.leaveStream(id, user);
  }

  @Get(':id/viewers')
  @RequirePermissions('live.stream.view')
  @ApiOperation({ summary: 'List public stream viewers (excludes moderators)' })
  getViewers(@Param('id', ParseUuidPipe) id: string) {
    return this.service.getStreamViewers(id);
  }
}
