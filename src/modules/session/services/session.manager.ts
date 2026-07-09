import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionEventType } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  DEVICE_SERVICE,
  type IDeviceService,
} from 'src/modules/device/interfaces/device.interface';
import { SessionLoggedOutEvent } from '../events/session.events';
import type {
  AuthTokens,
  ISessionService,
  SessionClaims,
  SessionContext,
  SessionView,
} from '../interfaces/session.interface';
import { SessionRepository } from '../repositories/session.repository';
import { SessionService } from './session.service';

/**
 * User/multi-session policy layer and the public SESSION_SERVICE facade.
 * Enforces the concurrent-session limit on create, exposes session listing,
 * per-session and all-device logout, admin forced logout, and device trust.
 * Delegates the actual per-session mechanics to SessionService.
 */
@Injectable()
export class SessionManager implements ISessionService {
  private readonly maxConcurrent: number;

  constructor(
    private readonly service: SessionService,
    private readonly repo: SessionRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(DEVICE_SERVICE) private readonly devices: IDeviceService,
    config: ConfigService,
  ) {
    this.maxConcurrent = Number(config.get('session', { infer: true })!.maxConcurrent);
  }

  async createSession(
    claims: SessionClaims,
    ctx: SessionContext,
  ): Promise<{ sessionId: string; tokens: AuthTokens }> {
    await this.enforceConcurrentLimit(claims.userId);
    return this.service.createSession(claims, ctx);
  }

  refresh(
    userId: string,
    sessionId: string,
    presentedToken: string,
    claims: SessionClaims,
    ctx: SessionContext,
  ): Promise<AuthTokens> {
    return this.service.refresh(userId, sessionId, presentedToken, claims, ctx);
  }

  async logoutCurrent(userId: string, sessionId: string): Promise<void> {
    await this.service.revokeSession(userId, sessionId, 'user');
    await this.bus.publish(new SessionLoggedOutEvent({ userId, sessionId, allDevices: false }));
  }

  async logoutAll(userId: string): Promise<void> {
    await this.service.revokeAllForUser(userId, 'user');
    await this.bus.publish(
      new SessionLoggedOutEvent({ userId, sessionId: null, allDevices: true }),
    );
  }

  /** Revoke one specific session, verifying it belongs to the caller. */
  async revoke(userId: string, sessionId: string): Promise<void> {
    await this.assertOwnership(userId, sessionId);
    await this.service.revokeSession(userId, sessionId, 'user');
    await this.bus.publish(new SessionLoggedOutEvent({ userId, sessionId, allDevices: false }));
  }

  async adminForceLogout(targetUserId: string, actorId: string): Promise<void> {
    await this.service.revokeAllForUser(targetUserId, 'admin');
    await this.repo.recordEvent({
      userId: targetUserId,
      event: SessionEventType.ADMIN_LOGOUT,
      metadata: { actorId },
    });
    await this.bus.publish(
      new SessionLoggedOutEvent({
        userId: targetUserId,
        sessionId: null,
        allDevices: true,
        byAdmin: true,
      }),
    );
  }

  async listUserSessions(userId: string, currentSessionId?: string): Promise<SessionView[]> {
    const sessions = await this.repo.listActiveSessions(userId);
    return Promise.all(
      sessions.map(async (s): Promise<SessionView> => {
        const trusted = s.deviceId ? await this.devices.isTrusted(s.deviceId) : false;
        return {
          sessionId: s.id,
          deviceId: s.deviceId,
          platform: s.platform,
          ip: s.createdByIp,
          userAgent: s.userAgent,
          trusted,
          current: s.id === currentSessionId,
          lastActivityAt: s.lastActivityAt,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
        };
      }),
    );
  }

  async trustDevice(userId: string, sessionId: string, trusted: boolean): Promise<void> {
    const session = await this.assertOwnership(userId, sessionId);
    if (!session.deviceId) {
      throw new BusinessException(
        ERROR_CODES.SESSION_NOT_FOUND,
        'This session has no associated device',
        HttpStatus.BAD_REQUEST,
      );
    }
    // Delegate to the device module (owner of the trust ledger + flag).
    if (trusted) await this.devices.trustDevice(userId, session.deviceId);
    else await this.devices.untrustDevice(userId, session.deviceId);
  }

  // ---- Internal ----

  /**
   * Keep active sessions at or below the configured cap: before minting a new
   * one, evict the oldest sessions so the total (incl. the incoming session)
   * never exceeds the limit.
   */
  private async enforceConcurrentLimit(userId: string): Promise<void> {
    const active = await this.repo.listActiveSessions(userId); // ordered oldest → newest
    const overBy = active.length - this.maxConcurrent + 1;
    if (overBy <= 0) return;
    const toEvict = active.slice(0, overBy);
    for (const s of toEvict) {
      await this.service.revokeSession(userId, s.id, 'concurrent');
    }
  }

  private async assertOwnership(userId: string, sessionId: string) {
    const session = await this.repo.getSession(sessionId);
    if (!session || session.userId !== userId) {
      throw new BusinessException(
        ERROR_CODES.SESSION_NOT_FOUND,
        'Session not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return session;
  }
}
