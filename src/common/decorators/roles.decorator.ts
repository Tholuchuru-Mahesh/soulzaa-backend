import { SetMetadata } from '@nestjs/common';
import { ROLES_KEY, type PlatformRole } from '../constants';

/** Restricts a route to the listed platform roles (enforced by RolesGuard). */
export const Roles = (...roles: PlatformRole[]) => SetMetadata(ROLES_KEY, roles);
