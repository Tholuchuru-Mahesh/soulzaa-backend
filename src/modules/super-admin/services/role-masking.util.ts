/**
 * Label shown in place of a role the viewer may not identify. Deliberately
 * generic: "STAFF" reveals that the account is privileged (which the operator
 * can already infer from the console they are in) without revealing *which*
 * privilege — and therefore without naming a target.
 */
export const MASKED_ROLE_LABEL = 'STAFF';

/** Roles no operator below them may identify. */
const PRIVILEGED_ROLES = new Set(['SUPER_ADMIN']);

/**
 * Masks role names the viewer is not entitled to identify.
 *
 * Spec §1: an Admin "cannot identify Super Admin". Applied at the projection
 * boundary so detail, list and audit reads all inherit it — a per-route check
 * would eventually miss one.
 */
export function maskPrivilegedRoles(roleNames: string[], viewerIsSuperAdmin: boolean): string[] {
  if (viewerIsSuperAdmin) return roleNames;
  return roleNames.map((name) => (PRIVILEGED_ROLES.has(name) ? MASKED_ROLE_LABEL : name));
}

/** Single-value form, for projections that carry one role name per row. */
export function maskPrivilegedRole(roleName: string, viewerIsSuperAdmin: boolean): string {
  return maskPrivilegedRoles([roleName], viewerIsSuperAdmin)[0];
}
