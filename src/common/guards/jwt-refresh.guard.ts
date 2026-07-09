import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Opt-in guard for the refresh endpoint: `@UseGuards(JwtRefreshGuard)` + `@Public()`
 * (to bypass the global access-token guard). Uses the 'jwt-refresh' strategy, so
 * `request.user` becomes `{ id, refreshToken }`.
 */
@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {}
