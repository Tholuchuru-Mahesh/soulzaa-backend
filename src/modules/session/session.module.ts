import { Global, Module } from '@nestjs/common';
import { SessionController } from './controllers/session.controller';
import { SESSION_SERVICE } from './interfaces/session.interface';
import { SessionSocketListener } from './listeners/session-socket.listener';
import { SessionRepository } from './repositories/session.repository';
import { SessionManager } from './services/session.manager';
import { SessionService } from './services/session.service';

/**
 * Session domain — multi-device sessions with refresh-token rotation, reuse +
 * hijack detection, inactivity expiry, concurrent-session limits, device trust,
 * a session_history audit trail, admin forced-logout, and socket teardown on
 * logout.
 *
 * @Global so consumers (auth) resolve SESSION_SERVICE by the interface token
 * without importing this module — respecting the boundary rule (cross-module
 * access only via `interfaces/`). Owns user_sessions, user_devices,
 * session_history and the Redis session cache.
 */
@Global()
@Module({
  controllers: [SessionController],
  providers: [
    SessionRepository,
    SessionService,
    SessionManager,
    SessionSocketListener,
    { provide: SESSION_SERVICE, useExisting: SessionManager },
  ],
  exports: [SESSION_SERVICE],
})
export class SessionModule {}
