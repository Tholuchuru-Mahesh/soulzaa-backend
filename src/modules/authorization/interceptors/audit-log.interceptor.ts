import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AUDIT_LOG_ACTION_KEY, AuditLogMetadata } from '../decorators/authorization.decorators';
import { AuditLogService } from '../services/audit-log.service';

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditLogService: AuditLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const meta = this.reflector.getAllAndOverride<AuditLogMetadata>(AUDIT_LOG_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!meta) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const resourceId = req.params?.id || req.body?.id || req.query?.id;

    return next.handle().pipe(
      tap({
        next: (data) => {
          if (user?.id) {
            this.auditLogService.logAction({
              actorId: user.id,
              actorRole: user.roles?.[0] || 'USER',
              action: meta.action,
              resource: meta.resource,
              resourceId: resourceId ? String(resourceId) : undefined,
              details: {
                params: req.params,
                query: req.query,
                body: this.sanitizeBody(req.body),
              },
              ipAddress: String(ipAddress),
              userAgent,
              status: 'SUCCESS',
            });
          }
        },
        error: (err) => {
          if (user?.id) {
            this.auditLogService.logAction({
              actorId: user.id,
              actorRole: user.roles?.[0] || 'USER',
              action: meta.action,
              resource: meta.resource,
              resourceId: resourceId ? String(resourceId) : undefined,
              details: {
                error: err.message,
                params: req.params,
              },
              ipAddress: String(ipAddress),
              userAgent,
              status: 'FAILED',
            });
          }
        },
      }),
    );
  }

  private sanitizeBody(body: any): any {
    if (!body || typeof body !== 'object') return body;
    const sanitized = { ...body };
    delete sanitized.password;
    delete sanitized.token;
    delete sanitized.secret;
    return sanitized;
  }
}
