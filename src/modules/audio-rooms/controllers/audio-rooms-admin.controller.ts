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
import { IsBoolean } from 'class-validator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { ListModerationDto } from '../dto/moderation.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomsService } from '../services/audio-rooms.service';
import { ModerationService } from '../services/moderation.service';

export class LockRoomAdminDto {
  @IsBoolean()
  isLocked!: boolean;
}

@ApiTags('audio-rooms-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/rooms')
export class AudioRoomsAdminController {
  constructor(
    private readonly rooms: AudioRoomsService,
    private readonly moderation: ModerationService,
    private readonly prisma: PrismaService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete/disband a room permanently' })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.rooms.remove(this.actor(user), id);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End the active room live session' })
  async end(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.rooms.end(this.actor(user), id);
    return { ended: true };
  }

  @Post(':id/lock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lock or unlock a room' })
  async lock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: LockRoomAdminDto,
  ) {
    return this.rooms.setLock(this.actor(user), id, dto.isLocked);
  }

  @Post(':id/remove-owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove the room owner — promote the highest-ranking member, or close the room',
  })
  async removeOwner(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    await this.rooms.removeOwner(this.actor(user), id);
    return { ownerRemoved: true };
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'List active members/participants of the room' })
  async members(@Param('id', ParseUuidPipe) id: string) {
    const detail = await this.rooms.getRoomDetail(id);
    return detail.participants;
  }

  @Get(':id/gifts')
  @ApiOperation({ summary: 'View paginated gift transactions for the room' })
  async gifts(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    const where = {
      contextId: id,
      contextType: 'AUDIO_ROOM' as const,
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.giftTransaction.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.giftTransaction.count({ where }),
    ]);

    // Format BigInts to string
    const items = rows.map((r) => ({
      ...r,
      totalCoinValue: r.totalCoinValue.toString(),
      creatorEarnings: r.creatorEarnings.toString(),
    }));

    return buildPaginated(items, total, q.page, q.limit);
  }

  @Get(':id/logs')
  @ApiOperation({ summary: 'View paginated audit logs for the room' })
  async logs(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    const where = { roomId: id };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.roomLog.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.roomLog.count({ where }),
    ]);

    return buildPaginated(items, total, q.page, q.limit);
  }

  // ---- Room Moderation Delegations ----

  @Get(':id/moderation/bans')
  @ApiOperation({ summary: 'List active room bans' })
  bans(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listBans(id, q);
  }

  @Get(':id/moderation/mutes')
  @ApiOperation({ summary: 'List active room mutes' })
  mutes(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listMutes(id, q);
  }

  @Get(':id/moderation/actions')
  @ApiOperation({ summary: 'List room moderation actions' })
  actions(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listActions(id, q);
  }

  @Get(':id/moderation/reports')
  @ApiOperation({ summary: 'List room moderation reports' })
  reports(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listReports(id, q);
  }

  @Get(':id/moderation/appeals')
  @ApiOperation({ summary: 'List room moderation appeals' })
  appeals(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listAppeals(id, q);
  }
}
