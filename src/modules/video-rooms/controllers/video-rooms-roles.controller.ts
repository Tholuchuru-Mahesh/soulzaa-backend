import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PlatformRole, VideoRoomMemberRole } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { VideoRoomPermission, videoRoomRolePermissions } from '../constants/video-room-permissions';
import { GrantVideoRoomRoleDto } from '../dto/grant-video-room-role.dto';
import {
  MyVideoRoomPermissionsDto,
  RemoveVideoRoomRoleDto,
  TransferVideoRoomOwnershipDto,
  UpdateVideoRoomRoleDto,
  VideoRoomPermissionCatalogueDto,
  VideoRoomRoleResponseDto,
} from '../dto/video-room-role.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomOwnershipService } from '../services/video-room-ownership.service';
import { VideoRoomPermissionService } from '../services/video-room-permission.service';
import { VideoRoomRoleService } from '../services/video-room-role.service';

/**
 * Video Room role & permission REST surface (VR-7). Commands come in over REST;
 * realtime fan-out is EVENT_BUS → VideoRoomRoleSocketListener. There is no domain
 * socket gateway — the `/video-room` namespace stays broadcast-only, as in every
 * prior phase.
 *
 * The global JwtAuthGuard secures every route; state-changing routes deny guests
 * and return 200. **All authorization lives in the services** — this controller
 * only shapes requests and responses, so there is exactly one place where a
 * permission decision can be got wrong.
 */
@ApiTags('video-rooms')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomRolesController {
  constructor(
    private readonly roles: VideoRoomRoleService,
    private readonly ownership: VideoRoomOwnershipService,
    private readonly permissions: VideoRoomPermissionService,
    private readonly rooms: VideoRoomsRepository,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  /**
   * Declared before the `:id/...` routes so the literal segment is matched first —
   * Nest resolves routes in declaration order, and `permissions` would otherwise
   * be a candidate for a `:id` parameter on a same-shaped path.
   */
  @Get('permissions')
  @ApiOperation({ summary: 'The video-room permission catalogue and role matrix' })
  @ApiResponse({ status: HttpStatus.OK, type: VideoRoomPermissionCatalogueDto })
  catalogue(): VideoRoomPermissionCatalogueDto {
    const matrix = Object.fromEntries(
      Object.values(VideoRoomMemberRole).map((role) => [role, videoRoomRolePermissions(role)]),
    ) as Record<VideoRoomMemberRole, VideoRoomPermission[]>;
    return { permissions: Object.values(VideoRoomPermission), matrix };
  }

  @Get(':id/roles')
  @ApiOperation({ summary: 'List the elevated role grants in a room' })
  @ApiResponse({ status: HttpStatus.OK, type: VideoRoomRoleResponseDto, isArray: true })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'You are not a member of this room.',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
  ): Promise<VideoRoomRoleResponseDto[]> {
    return this.roles.listRoles(this.actor(user), roomId);
  }

  @Get(':id/me/permissions')
  @ApiOperation({ summary: "The caller's effective role and capability set in a room" })
  @ApiResponse({ status: HttpStatus.OK, type: MyVideoRoomPermissionsDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  async myPermissions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
  ): Promise<MyVideoRoomPermissionsDto> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return this.permissions.resolveCapabilities(this.actor(user), {
      id: room.id,
      ownerId: room.ownerId,
    });
  }

  @Post(':id/roles/assign')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Grant an elevated in-room role (owner only)',
    description:
      'Requires GRANT_ROLES, which the PRD reserves to the room owner. The target must be an active member, must be outranked by the actor, and must not be the owner. A room holds at most 25 admins.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: VideoRoomRoleResponseDto })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not permitted, or the target outranks you / is the owner.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Duplicate role, or the 25-admin cap is reached.',
  })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Target is not an active member.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: GrantVideoRoomRoleDto,
  ): Promise<VideoRoomRoleResponseDto> {
    return this.roles.assign(this.actor(user), roomId, dto);
  }

  @Post(':id/roles/remove')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an elevated in-room role (owner only)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Revoked.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'That user holds no grant.' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'The owner role cannot be revoked — transfer instead.',
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: RemoveVideoRoomRoleDto,
  ): Promise<void> {
    return this.roles.remove(this.actor(user), roomId, dto);
  }

  @Patch(':id/roles/update')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Replace a user's elevated role and/or its expiry (owner only)" })
  @ApiResponse({ status: HttpStatus.OK, type: VideoRoomRoleResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'That user holds no grant to update.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'The 25-admin cap is reached.' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: UpdateVideoRoomRoleDto,
  ): Promise<VideoRoomRoleResponseDto> {
    return this.roles.update(this.actor(user), roomId, dto);
  }

  @Post(':id/owner/transfer')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transfer room ownership to another active member (owner only)',
    description:
      'The previous owner is demoted to ADMIN. Serialised under a per-room lock; exactly one owner exists at any moment.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Ownership transferred.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'That user is already the owner.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Target is not an active member.' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Only the owner may transfer ownership.',
  })
  transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: TransferVideoRoomOwnershipDto,
  ): Promise<void> {
    return this.ownership.transfer(this.actor(user), roomId, dto);
  }

  @Post(':id/owner/recover')
  @Roles(PlatformRole.ADMIN, PlatformRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Promote the highest-ranking remaining member to owner (platform staff only)',
    description:
      'Recovery for an orphaned room; closes the room when no successor exists. Has no automatic trigger by design — an owner leaving a room is normal and reversible, so auto-succession would hand rooms away from owners who are merely reconnecting.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The new owner id, or null when the room was closed for lack of a successor.',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  recover(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
  ): Promise<{ newOwnerId: string | null }> {
    return this.ownership.recoverOwner(this.actor(user), roomId);
  }
}
