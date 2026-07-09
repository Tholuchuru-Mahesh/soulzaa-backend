import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from './common/decorators/current-user.decorator';
import { Public } from './common/decorators/public.decorator';
import type { AuthenticatedUser } from './common/interfaces/authenticated-user';

/**
 * Root probes. `GET /ping` is public; `GET /me` is guarded — together they
 * verify the global JWT guard, @Public bypass, and @CurrentUser wiring.
 * Domain endpoints live in their own modules.
 */
@ApiTags('root')
@Controller()
export class AppController {
  @Get('ping')
  @Public()
  @ApiOperation({ summary: 'Liveness probe (public)' })
  ping() {
    return { pong: true, service: 'soulzaa-backend' };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Echo the authenticated user (requires JWT)' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return { user };
  }
}
