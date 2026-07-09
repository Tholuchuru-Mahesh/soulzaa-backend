import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { ApplyThemeDto, SetDecorationsDto } from '../dto/room-appearance.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { RoomAppearanceService } from '../services/room-appearance.service';

/**
 * Room appearance REST surface (base `rooms/:id/appearance`). JWT-guarded.
 * Applying a theme/decorations requires room owner/admin authority AND ownership
 * of the cosmetic (enforced in the service); reads are open to participants.
 */
@ApiTags('audio-room-appearance')
@ApiBearerAuth()
@Controller('rooms')
export class RoomAppearanceController {
  constructor(private readonly appearance: RoomAppearanceService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Get(':id/appearance')
  @ApiOperation({ summary: 'Get the room’s active theme + decorations' })
  get(@Param('id', ParseUuidPipe) id: string) {
    return this.appearance.getAppearance(id);
  }

  @Post(':id/appearance/theme')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Apply an owned THEME to the room (owner/admin)' })
  applyTheme(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ApplyThemeDto,
  ) {
    return this.appearance.applyTheme(this.actor(user), id, dto.cosmeticId);
  }

  @Delete(':id/appearance/theme')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Remove the room theme (owner/admin)' })
  removeTheme(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.appearance.removeTheme(this.actor(user), id);
  }

  @Put(':id/appearance/decorations')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Set the room decorations from owned cosmetics (owner/admin)' })
  setDecorations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SetDecorationsDto,
  ) {
    return this.appearance.setDecorations(this.actor(user), id, dto.cosmeticIds);
  }

  @Post(':id/appearance/reset')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Reset the room appearance (owner/admin)' })
  reset(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.appearance.reset(this.actor(user), id);
  }
}
