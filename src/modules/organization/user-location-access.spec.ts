import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from 'src/common/constants';
import {
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  type SystemRoleType,
} from 'src/modules/authorization/constants/rbac-permissions.constants';
import { UserLocationController } from './controllers/user-location.controller';

const reflector = new Reflector();

describe('user location access', () => {
  it('defines both location permissions', () => {
    const codes = DEFAULT_PERMISSIONS.map((p) => p.code);
    expect(codes).toContain('user.location.view');
    expect(codes).toContain('user.location.assign');
  });

  it('gates reads on user.location.view', () => {
    expect(reflector.get<string[]>(PERMISSIONS_KEY, UserLocationController.prototype.get)).toEqual([
      'user.location.view',
    ]);
  });

  it('gates assignment on user.location.assign', () => {
    expect(
      reflector.get<string[]>(PERMISSIONS_KEY, UserLocationController.prototype.assign),
    ).toEqual(['user.location.assign']);
  });

  it('gates the backfill on user.location.assign', () => {
    expect(
      reflector.get<string[]>(PERMISSIONS_KEY, UserLocationController.prototype.backfill),
    ).toEqual(['user.location.assign']);
  });

  it('grants ADMIN both view and assign', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain('user.location.view');
    expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain('user.location.assign');
  });

  it.each(['COUNTRY_MANAGER', 'OFFICIAL', 'MODERATOR'])(
    'gives %s read access but never assignment',
    (role) => {
      const granted = DEFAULT_ROLE_PERMISSIONS[role as SystemRoleType];
      expect(granted).toContain('user.location.view');
      // Reassigning users would let an official edit their own territory.
      expect(granted).not.toContain('user.location.assign');
    },
  );

  it('keeps geography management out of ADMIN — that stays SUPER_ADMIN', () => {
    const granted: string[] = DEFAULT_ROLE_PERMISSIONS.ADMIN;
    expect(granted).not.toContain('organization.country.manage');
    expect(granted).not.toContain('organization.state.manage');
    expect(granted).not.toContain('organization.region.manage');
  });
});
