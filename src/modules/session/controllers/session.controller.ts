import { Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { SESSION_SERVICE, type ISessionService } from '../interfaces/session.interface';

/**
 * Session/device management surface. All routes require a valid access token
 * (global JwtAuthGuard). Users manage their own sessions; the admin route is
 * gated by @Roles — RolesGuard runs globally and SUPER_ADMIN always passes.
 */
@ApiTags('sessions')
@ApiBearerAuth()
@Controller()
export class SessionController {
  constructor(@Inject(SESSION_SERVICE) private readonly sessions: ISessionService) {}

  @Get('sessions')
  @ApiOperation({ summary: 'List my active sessions / devices' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.sessions.listUserSessions(user.id, user.sid);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke one of my sessions' })
  async revoke(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.sessions.revoke(user.id, id);
    return { revoked: true };
  }

  @Post('sessions/logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log out of all my devices' })
  async logoutAll(@CurrentUser() user: AuthenticatedUser) {
    await this.sessions.logoutAll(user.id);
    return { message: 'Logged out from all devices' };
  }

  @Post('sessions/:id/trust')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark the device behind a session as trusted' })
  async trust(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.sessions.trustDevice(user.id, id, true);
    return { trusted: true };
  }

  @Post('sessions/:id/untrust')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove trust from the device behind a session' })
  async untrust(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.sessions.trustDevice(user.id, id, false);
    return { trusted: false };
  }

  @Post('admin/sessions/:userId/logout')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: force-logout all sessions of a user' })
  async adminForceLogout(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    await this.sessions.adminForceLogout(userId, actor.id);
    return { message: 'User forcibly logged out' };
  }
}
