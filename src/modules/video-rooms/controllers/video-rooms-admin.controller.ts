import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { ListModerationDto } from '../dto/moderation.dto';
import {
  AdminListRoomsQueryDto,
  BanUserAdminDto,
  DisableChatAdminDto,
  LockRoomAdminDto,
  MuteUserAdminDto,
  RemoveParticipantAdminDto,
  ReviewReportAdminDto,
} from '../dto/video-room-admin.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomsAdminRepository } from '../repositories/video-rooms-admin.repository';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomReportRepository } from '../repositories/video-room-report.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomsAdminService } from '../services/video-rooms-admin.service';

@ApiTags('video-rooms-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/video-rooms')
export class VideoRoomsAdminController {
  constructor(
    private readonly adminService: VideoRoomsAdminService,
    private readonly adminRepository: VideoRoomsAdminRepository,
    private readonly roomsRepository: VideoRoomsRepository,
    private readonly moderationRepository: VideoRoomModerationRepository,
    private readonly reportRepository: VideoRoomReportRepository,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Get('dashboard/overview')
  @ApiOperation({ summary: 'Operational dashboard overview for video rooms' })
  async getDashboardOverview(@CurrentUser() user: AuthenticatedUser) {
    return this.adminService.getDashboardOverview(this.actor(user));
  }

  @Get()
  @ApiOperation({ summary: 'List/search video rooms for administration' })
  async listRooms(@CurrentUser() user: AuthenticatedUser, @Query() q: AdminListRoomsQueryDto) {
    const { items, total } = await this.adminService.listRooms(this.actor(user), q);
    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get detailed video room info for administration' })
  async getRoomDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    return this.adminService.getRoomDetail(this.actor(user), id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete/disband a video room permanently' })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.adminService.remove(this.actor(user), id);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End the active video room live session' })
  async end(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.adminService.end(this.actor(user), id);
    return { ended: true };
  }

  @Post(':id/lock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lock or unlock a video room' })
  async lock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: LockRoomAdminDto,
  ) {
    return this.adminService.setLock(this.actor(user), id, dto.isLocked);
  }

  @Post(':id/remove-owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove the video room owner' })
  async removeOwner(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    await this.adminService.removeOwner(this.actor(user), id);
    return { ownerRemoved: true };
  }

  @Post(':id/remove-participant')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove/kick a participant from a video room' })
  async removeParticipant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: RemoveParticipantAdminDto,
  ) {
    await this.adminService.removeParticipant(this.actor(user), id, dto.targetUserId, dto.reason);
    return { participantRemoved: true };
  }

  @Post(':id/disable-chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable or enable chat in a video room' })
  async disableChat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: DisableChatAdminDto,
  ) {
    await this.adminService.disableChat(this.actor(user), id, dto.isChatDisabled);
    return { chatDisabled: dto.isChatDisabled };
  }

  @Post(':id/moderation/ban/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ban a user from a video room administratively' })
  async banUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: BanUserAdminDto,
  ) {
    await this.adminService.banUser(this.actor(user), id, userId, dto);
    return { banned: true };
  }

  @Post(':id/moderation/unban/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unban a user from a video room administratively' })
  async unbanUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    await this.adminService.unbanUser(this.actor(user), id, userId);
    return { unbanned: true };
  }

  @Post(':id/moderation/mute/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mute a user in a video room administratively' })
  async muteUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: MuteUserAdminDto,
  ) {
    await this.adminService.muteUser(this.actor(user), id, userId, dto);
    return { muted: true };
  }

  @Post(':id/moderation/unmute/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unmute a user in a video room administratively' })
  async unmuteUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    await this.adminService.unmuteUser(this.actor(user), id, userId);
    return { unmuted: true };
  }

  @Post(':id/reports/:reportId/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Review/resolve a moderation report' })
  async reviewReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: ReviewReportAdminDto,
  ) {
    await this.adminService.reviewReport(this.actor(user), id, reportId, dto);
    return { reportReviewed: true };
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'List active members/participants of the video room' })
  async members(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    const members = await this.roomsRepository.listActiveMembers(id, q.limit || 20, q.skip || 0);
    return members;
  }

  @Get(':id/gifts')
  @ApiOperation({ summary: 'View paginated gift transactions for the video room' })
  async gifts(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    const { items, total } = await this.adminRepository.getRoomGiftTransactions(
      id,
      q.skip,
      q.limit,
    );
    return buildPaginated(items, total, q.page, q.limit);
  }

  @Get(':id/logs')
  @ApiOperation({ summary: 'View paginated audit logs for the video room' })
  async logs(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    const { items, total } = await this.adminRepository.getRoomLogs(id, q.skip, q.limit);
    return buildPaginated(items, total, q.page, q.limit);
  }

  @Get(':id/moderation/bans')
  @ApiOperation({ summary: 'List active room bans' })
  async bans(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    const [items, total] = await this.moderationRepository.listActiveBlocks(
      id,
      q.skip || 0,
      q.limit || 20,
    );
    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }

  @Get(':id/moderation/mutes')
  @ApiOperation({ summary: 'List active room mutes' })
  async mutes(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    const [items, total] = await this.moderationRepository.listActiveMutes(
      id,
      q.skip || 0,
      q.limit || 20,
    );
    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }

  @Get(':id/moderation/actions')
  @ApiOperation({ summary: 'List room moderation actions' })
  async actions(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    const [items, total] = await this.moderationRepository.listActions(
      id,
      q.skip || 0,
      q.limit || 20,
    );
    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }

  @Get(':id/moderation/reports')
  @ApiOperation({ summary: 'List room moderation reports' })
  async reports(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    const [items, total] = await this.reportRepository.list(id, {
      skip: q.skip || 0,
      take: q.limit || 20,
    });
    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }
}
