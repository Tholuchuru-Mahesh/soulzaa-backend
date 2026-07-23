import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { PERMISSIONS_KEY, ROLES_KEY } from 'src/common/constants';

export const AUDIT_LOG_ACTION_KEY = 'auditLogAction';

export interface AuditLogMetadata {
  action: string;
  resource: string;
}

/**
 * Decorator enforcing fine-grained permissions on NestJS endpoints.
 * @example @RequirePermissions('wallet.adjust', 'user.update')
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Decorator enforcing role requirements on NestJS endpoints.
 * @example @RequireRoles('ADMIN', 'MODERATOR')
 */
export const RequireRoles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Decorator to automatically trigger audit log recording on controller actions.
 * @example @AuditLogAction('user.ban', 'user')
 */
export const AuditLogAction = (action: string, resource: string) =>
  SetMetadata(AUDIT_LOG_ACTION_KEY, { action, resource } as AuditLogMetadata);

/**
 * Parameter decorator extracting authenticated user from request object.
 */
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);

/**
 * Parameter decorator extracting geographic scope context from request headers/params.
 */
export const CurrentScope = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return {
    countryCode:
      request.headers['x-country-code'] || request.query?.countryCode || request.body?.countryCode,
    stateCode:
      request.headers['x-state-code'] || request.query?.stateCode || request.body?.stateCode,
    regionCode:
      request.headers['x-region-code'] || request.query?.regionCode || request.body?.regionCode,
  };
});
