import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { CreateVideoRoomDto } from '../dto/create-video-room.dto';
import { ListVideoRoomsDto } from '../dto/list-video-rooms.dto';
import { LockVideoRoomDto } from '../dto/lock-video-room.dto';
import { SearchVideoRoomsDto } from '../dto/search-video-rooms.dto';
import { UpdateVideoRoomSettingsDto } from '../dto/update-video-room-settings.dto';
import { UpdateVideoRoomDto } from '../dto/update-video-room.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomLifecycleService } from '../services/video-room-lifecycle.service';
import { VideoRoomQueryService } from '../services/video-room-query.service';
import { VideoRoomSettingsService } from '../services/video-room-settings.service';

/**
 * Video Room lifecycle REST surface (base `video-rooms`, VR-2). The global
 * JwtAuthGuard secures every route; writes are denied to guests (@NotGuest); UUID
 * params are validated; bodies are validated against their DTOs. Ownership / RBAC
 * checks live in the services (VideoRoomPermissionService) — no per-route role
 * guards. Reads flow through the query service; commands through the lifecycle
 * service (CQRS-ready split). Static/discovery routes are declared before `:id`
 * so they are not captured by the param route.
 */
@ApiTags('video-rooms')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsController {
  constructor(
    private readonly lifecycle: VideoRoomLifecycleService,
    private readonly query: VideoRoomQueryService,
    private readonly settings: VideoRoomSettingsService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  // ---- Discovery / static routes (before ':id') ----

  @Get('search')
  @ApiOperation({ summary: 'Faceted search (category/language/country/tags/access policy)' })
  search(@CurrentUser() user: AuthenticatedUser, @Query() query: SearchVideoRoomsDto) {
    return this.query.search(query, this.actor(user));
  }

  @Get('trending')
  @ApiOperation({ summary: 'Trending rooms (global trending set, highest first)' })
  trending(@Query() query: ListVideoRoomsDto) {
    return this.query.trending(query.limit);
  }

  @Get('popular')
  @ApiOperation({ summary: 'Popular rooms (ranked by room statistics)' })
  popular(@CurrentUser() user: AuthenticatedUser, @Query() query: ListVideoRoomsDto) {
    return this.query.popular(query, this.actor(user));
  }

  @Get('featured')
  @ApiOperation({ summary: 'Featured (verified) rooms' })
  featured(@CurrentUser() user: AuthenticatedUser, @Query() query: ListVideoRoomsDto) {
    return this.query.featured(query, this.actor(user));
  }

  @Get('mine')
  @ApiOperation({ summary: "The caller's own rooms" })
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.query.mine(this.actor(user));
  }

  @Get()
  @ApiOperation({ summary: 'List / discover video rooms (newest first)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListVideoRoomsDto) {
    return this.query.list(query, this.actor(user));
  }

  @Post()
  @NotGuest()
  @ApiOperation({ summary: 'Create a video room' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'The created room detail.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Owner is at their room cap.' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateVideoRoomDto) {
    return this.lifecycle.create(this.actor(user), dto);
  }

  // ---- Single-room reads ----

  @Get(':id')
  @ApiOperation({ summary: 'Get complete room detail' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  detail(@Param('id', ParseUuidPipe) id: string) {
    return this.query.getDetail(id);
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Verify room lifecycle status' })
  status(@Param('id', ParseUuidPipe) id: string) {
    return this.query.verifyStatus(id);
  }

  // ---- Mutations ----

  @Patch(':id')
  @NotGuest()
  @ApiOperation({ summary: 'Update a video room (owner/admin)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateVideoRoomDto,
  ) {
    return this.lifecycle.update(this.actor(user), id, dto);
  }

  @Patch(':id/settings')
  @NotGuest()
  @ApiOperation({
    summary: "Patch a room's configurable settings (per-field permission gated)",
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'The updated settings row.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Field not writable here.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Missing a required permission.' })
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateVideoRoomSettingsDto,
  ) {
    return this.settings.update(this.actor(user), id, dto);
  }

  @Delete(':id')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a video room (owner). History retained.' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.lifecycle.remove(this.actor(user), id);
  }

  @Post(':id/activate')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate a room (CREATED → ACTIVE / go live)' })
  activate(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.lifecycle.activate(this.actor(user), id);
  }

  @Post(':id/close')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close a room (→ ENDED, owner)' })
  close(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.lifecycle.close(this.actor(user), id);
  }

  @Post(':id/reopen')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reopen a closed room (ENDED → CREATED)' })
  reopen(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.lifecycle.reopen(this.actor(user), id);
  }

  @Post(':id/lock')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lock a room / set-or-change its password' })
  lock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: LockVideoRoomDto,
  ) {
    return this.lifecycle.lock(this.actor(user), id, dto);
  }

  @Post(':id/unlock')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlock a room (clears the password)' })
  unlock(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.lifecycle.unlock(this.actor(user), id);
  }

  @Post(':id/restore')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a soft-deleted room' })
  restore(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.lifecycle.restore(this.actor(user), id);
  }
}
