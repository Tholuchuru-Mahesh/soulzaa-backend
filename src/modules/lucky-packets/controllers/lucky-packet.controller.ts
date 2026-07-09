import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { ClaimHistoryQueryDto, CreateLuckyPacketDto } from '../dto/lucky-packet.dto';
import { LuckyPacketService } from '../services/lucky-packet.service';

/**
 * Lucky packet REST surface (base `rooms/:id/lucky-packets`). JWT-guarded
 * globally. Creating a packet requires room owner/admin authority (enforced in
 * the service); claiming is open to any active member. Reads expose the active
 * packets, a single packet's live status, its claim ledger, and room history.
 */
@ApiTags('lucky-packets')
@ApiBearerAuth()
@Controller('rooms')
export class LuckyPacketController {
  constructor(private readonly packets: LuckyPacketService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/lucky-packets')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Create a lucky packet (owner/admin)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CreateLuckyPacketDto,
  ) {
    return this.packets.create(this.actor(user), id, dto);
  }

  @Post(':id/lucky-packets/:packetId/claim')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Claim a slot in a lucky packet' })
  claim(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('packetId', ParseUuidPipe) packetId: string,
  ) {
    return this.packets.claim(this.actor(user), id, packetId);
  }

  @Get(':id/lucky-packets/active')
  @ApiOperation({ summary: 'Active lucky packets in the room (connection recovery)' })
  active(@Param('id', ParseUuidPipe) id: string) {
    return this.packets.getActive(id);
  }

  @Get(':id/lucky-packets/history')
  @ApiOperation({ summary: 'Past lucky packets in the room' })
  history(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.packets.history(id, { skip: q.skip, limit: q.limit, page: q.page });
  }

  @Get(':id/lucky-packets/:packetId')
  @ApiOperation({ summary: 'Live status of a single lucky packet' })
  getOne(
    @Param('id', ParseUuidPipe) id: string,
    @Param('packetId', ParseUuidPipe) packetId: string,
  ) {
    return this.packets.getPacket(id, packetId);
  }

  @Get(':id/lucky-packets/:packetId/claims')
  @ApiOperation({ summary: 'Claim ledger for a lucky packet' })
  claims(
    @Param('id', ParseUuidPipe) id: string,
    @Param('packetId', ParseUuidPipe) packetId: string,
    @Query() q: ClaimHistoryQueryDto,
  ) {
    return this.packets.listClaims(id, packetId, {
      skip: q.skip,
      limit: q.limit,
      page: q.page,
      search: q.search,
    });
  }
}
