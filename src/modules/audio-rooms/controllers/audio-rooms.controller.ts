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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { CreateRoomDto } from '../dto/create-room.dto';
import { JoinRoomDto } from '../dto/join-room.dto';
import { ListRoomsDto } from '../dto/list-rooms.dto';
import { TransferOwnershipDto } from '../dto/transfer-ownership.dto';
import { UpdateRoomDto } from '../dto/update-room.dto';
import { AudioRoomsService, type RoomActor } from '../services/audio-rooms.service';

/**
 * Audio Room lifecycle REST surface (base `rooms`). The global JwtAuthGuard
 * secures every route; discovery reference lists (categories/languages) are
 * @Public. Room creation is denied to guest accounts (@NotGuest). Ownership /
 * admin checks live in the service.
 */
@ApiTags('audio-rooms')
@ApiBearerAuth()
@Controller('rooms')
export class AudioRoomsController {
  constructor(private readonly rooms: AudioRoomsService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  // ---- Static/reference routes (declared before ':id' to avoid capture) ----

  @Get('categories')
  @Public()
  @ApiOperation({ summary: 'List active room categories' })
  categories() {
    return this.rooms.listCategories();
  }

  @Get('languages')
  @Public()
  @ApiOperation({ summary: 'List supported room languages' })
  languages() {
    return this.rooms.listLanguages();
  }

  @Get('trending')
  @ApiOperation({ summary: 'List trending rooms' })
  trending(@Query() query: ListRoomsDto) {
    return this.rooms.trending(query.limit);
  }

  @Get()
  @ApiOperation({ summary: 'List / discover rooms' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListRoomsDto) {
    return this.rooms.list(query, this.actor(user));
  }

  @Post()
  @NotGuest()
  @ApiOperation({ summary: 'Create an audio room' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRoomDto) {
    return this.rooms.create(this.actor(user), dto);
  }

  @Get('mine')
  @ApiOperation({ summary: "Get the caller's owned room (or null)" })
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.rooms.getMyRoom(this.actor(user));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get room detail + live participants' })
  detail(@Param('id', ParseUuidPipe) id: string) {
    return this.rooms.getRoomDetail(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a room (owner/admin)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateRoomDto,
  ) {
    return this.rooms.update(this.actor(user), id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a room (owner/admin)' })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.rooms.remove(this.actor(user), id);
    return { deleted: true };
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End a room (owner/admin)' })
  async end(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.rooms.end(this.actor(user), id);
    return { ended: true };
  }

  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Join a room' })
  join(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: JoinRoomDto,
  ) {
    return this.rooms.join(this.actor(user), id, dto);
  }

  @Post(':id/leave')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Leave a room' })
  async leave(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.rooms.leave(this.actor(user), id);
    return { left: true };
  }

  @Post(':id/lock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lock a room (owner/admin)' })
  lock(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.rooms.setLock(this.actor(user), id, true);
  }

  @Post(':id/unlock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlock a room (owner/admin)' })
  unlock(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.rooms.setLock(this.actor(user), id, false);
  }

  @Post(':id/transfer-ownership')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer room ownership (owner/admin)' })
  transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: TransferOwnershipDto,
  ) {
    return this.rooms.transferOwnership(this.actor(user), id, dto);
  }
}
