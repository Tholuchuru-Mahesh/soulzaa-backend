import {
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  SYSTEM_ROLES,
} from './rbac-permissions.constants';

const WEB_DASHBOARD_PERMISSIONS = [
  'dashboard.financial.view',
  'dashboard.operations.view',
  'dashboard.engagement.view',
  'dashboard.moderation.view',
];

/**
 * The web admin console is for platform staff only. Every other role reaches the
 * platform through the mobile app, governed by its own permissions — so none of
 * them may hold a dashboard permission, directly or by inheritance.
 */
describe('web dashboard access is limited to ADMIN and SUPER_ADMIN', () => {
  it('defines every web dashboard permission', () => {
    const defined = DEFAULT_PERMISSIONS.map((p) => p.code);
    for (const code of WEB_DASHBOARD_PERMISSIONS) {
      expect(defined).toContain(code);
    }
  });

  it('grants all of them to ADMIN', () => {
    for (const code of WEB_DASHBOARD_PERMISSIONS) {
      expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain(code);
    }
  });

  it('grants SUPER_ADMIN everything via its wildcard', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN).toEqual(['*']);
  });

  const nonStaffRoles = Object.values(SYSTEM_ROLES).filter(
    (role) => role !== SYSTEM_ROLES.SUPER_ADMIN && role !== SYSTEM_ROLES.ADMIN,
  );

  it.each(nonStaffRoles)('does not grant any dashboard permission to %s', (role) => {
    const granted: string[] = DEFAULT_ROLE_PERMISSIONS[role] ?? [];
    expect(granted.filter((code) => code.startsWith('dashboard.'))).toEqual([]);
  });
});
