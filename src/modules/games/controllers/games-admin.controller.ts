import { Body, Controller, Get, Param, ParseEnumPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GameCode } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { UpdateGameDefinitionDto } from '../dto/games.dto';
import type { GameActor } from '../interfaces/game-actor.interface';
import { GamesService } from '../services/games.service';

/**
 * Platform-admin games configuration (base `admin/games`). Restricted to
 * ADMIN/SUPER_ADMIN. Manages the catalog (stakes, player bounds, house rake,
 * enable/disable) per the PRD's admin-configurable games requirement.
 */
@ApiTags('games-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/games')
export class GamesAdminController {
  constructor(private readonly games: GamesService) {}

  private actor(user: AuthenticatedUser): GameActor {
    return { id: user.id, roles: user.roles };
  }

  @Get()
  @ApiOperation({ summary: 'List the full game catalog (including disabled)' })
  list() {
    return this.games.listCatalog(true);
  }

  @Patch(':code')
  @ApiOperation({ summary: 'Update a game definition' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('code', new ParseEnumPipe(GameCode)) code: GameCode,
    @Body() dto: UpdateGameDefinitionDto,
  ) {
    return this.games.updateDefinition(this.actor(user), code, dto);
  }
}
