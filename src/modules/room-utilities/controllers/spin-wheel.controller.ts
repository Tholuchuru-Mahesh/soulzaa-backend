import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { CreateSpinWheelDto } from '../dto/room-utilities.dto';
import { SpinWheelService } from '../services/spin-wheel.service';

/**
 * Spin wheel REST surface (base `rooms/:id/spin-wheels`). Creating a wheel and
 * spinning it require owner/admin authority (enforced in the service); the
 * landed segment is server-decided and any coin reward credits the spinner.
 */
@ApiTags('room-utilities')
@ApiBearerAuth()
@Controller('rooms')
export class SpinWheelController {
  constructor(private readonly wheels: SpinWheelService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/spin-wheels')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Create a spin wheel (owner/admin)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CreateSpinWheelDto,
  ) {
    return this.wheels.createWheel(this.actor(user), id, dto);
  }

  @Post(':id/spin-wheels/:wheelId/spin')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Spin a wheel (owner/admin)' })
  spin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('wheelId', ParseUuidPipe) wheelId: string,
  ) {
    return this.wheels.spin(this.actor(user), id, wheelId);
  }

  @Get(':id/spin-wheels/active')
  @ApiOperation({ summary: 'Active spin wheels in the room (connection recovery)' })
  active(@Param('id', ParseUuidPipe) id: string) {
    return this.wheels.getActiveWheels(id);
  }

  @Get(':id/spin-wheels/history')
  @ApiOperation({ summary: 'Spin result history' })
  history(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.wheels.history(id, { skip: q.skip, limit: q.limit, page: q.page });
  }

  @Get(':id/spin-wheels/:wheelId')
  @ApiOperation({ summary: 'A single spin wheel with its segments' })
  getOne(@Param('id', ParseUuidPipe) id: string, @Param('wheelId', ParseUuidPipe) wheelId: string) {
    return this.wheels.getWheel(id, wheelId);
  }
}
