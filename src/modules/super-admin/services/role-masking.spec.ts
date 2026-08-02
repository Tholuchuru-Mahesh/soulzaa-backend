import { MASKED_ROLE_LABEL, maskPrivilegedRoles } from './role-masking.util';

/**
 * Spec §1: an Admin "cannot identify Super Admin". Admin holds `user.view` and
 * `user.profile.view`, so without masking it could read SUPER_ADMIN straight off
 * any user detail response and know exactly who to target.
 *
 * Masking happens at the projection boundary rather than per-route, so every
 * read — detail, list, audit history — inherits it without opting in.
 */
describe('maskPrivilegedRoles', () => {
  it('masks SUPER_ADMIN for a viewer who is not Super Admin', () => {
    expect(maskPrivilegedRoles(['SUPER_ADMIN'], false)).toEqual([MASKED_ROLE_LABEL]);
  });

  it('shows the real role to a Super Admin viewer', () => {
    expect(maskPrivilegedRoles(['SUPER_ADMIN'], true)).toEqual(['SUPER_ADMIN']);
  });

  it('leaves every other role untouched', () => {
    expect(maskPrivilegedRoles(['ADMIN', 'MODERATOR'], false)).toEqual(['ADMIN', 'MODERATOR']);
  });

  it('masks only the privileged entry in a mixed list', () => {
    expect(maskPrivilegedRoles(['SUPER_ADMIN', 'HOST'], false)).toEqual([
      MASKED_ROLE_LABEL,
      'HOST',
    ]);
  });

  it('does not leak the role through a duplicate entry', () => {
    expect(maskPrivilegedRoles(['SUPER_ADMIN', 'SUPER_ADMIN'], false)).toEqual([
      MASKED_ROLE_LABEL,
      MASKED_ROLE_LABEL,
    ]);
  });

  it('handles an empty list', () => {
    expect(maskPrivilegedRoles([], false)).toEqual([]);
  });
});
