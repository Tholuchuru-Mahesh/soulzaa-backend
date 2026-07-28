import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from 'src/common/constants';
import {
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  type SystemRoleType,
} from 'src/modules/authorization/constants/rbac-permissions.constants';
import { MobilePartnerController } from '../mobile-partner/controllers/mobile-partner.controller';
import { MobileWorkforceController } from './controllers/mobile-workforce.controller';

const reflector = new Reflector();

function handlersOf(controller: new (...args: never[]) => object): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor');
}

describe('mobile consoles are permission-gated', () => {
  it.each([
    ['workforce', MobileWorkforceController, 'mobile.workforce.view'],
    ['partner', MobilePartnerController, 'mobile.partner.view'],
  ] as Array<[string, new (...args: never[]) => object, string]>)(
    'every %s route resolves to its section permission',
    (_name, controller, expected) => {
      for (const handler of handlersOf(controller)) {
        const proto = controller.prototype as Record<string, unknown>;
        const effective = reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
          proto[handler] as never,
          controller,
        ]);
        expect(effective).toEqual([expected]);
      }
      expect(handlersOf(controller).length).toBeGreaterThan(0);
    },
  );
});

describe('mobile permissions are granted to the right roles', () => {
  it('defines both mobile permissions', () => {
    const codes = DEFAULT_PERMISSIONS.map((p) => p.code);
    expect(codes).toContain('mobile.workforce.view');
    expect(codes).toContain('mobile.partner.view');
  });

  it.each(['COUNTRY_MANAGER', 'OFFICIAL', 'MODERATOR'])(
    'grants the workforce console to %s',
    (role) => {
      expect(DEFAULT_ROLE_PERMISSIONS[role as SystemRoleType]).toContain('mobile.workforce.view');
    },
  );

  it.each(['AGENCY', 'COIN_SELLER', 'HOST'])('grants the partner console to %s', (role) => {
    expect(DEFAULT_ROLE_PERMISSIONS[role as SystemRoleType]).toContain('mobile.partner.view');
  });

  it('leaves BUSINESS_DEVELOPMENT off both consoles for now', () => {
    const granted: string[] = DEFAULT_ROLE_PERMISSIONS.BUSINESS_DEVELOPMENT ?? [];
    expect(granted.filter((code) => code.startsWith('mobile.'))).toEqual([]);
  });

  it('does not give a workforce role the partner console, or the reverse', () => {
    for (const role of ['COUNTRY_MANAGER', 'OFFICIAL', 'MODERATOR']) {
      expect(DEFAULT_ROLE_PERMISSIONS[role as SystemRoleType]).not.toContain('mobile.partner.view');
    }
    for (const role of ['AGENCY', 'COIN_SELLER', 'HOST']) {
      expect(DEFAULT_ROLE_PERMISSIONS[role as SystemRoleType]).not.toContain(
        'mobile.workforce.view',
      );
    }
  });

  it('keeps the web console out of every mobile role', () => {
    const mobileRoles = [
      'COUNTRY_MANAGER',
      'OFFICIAL',
      'MODERATOR',
      'AGENCY',
      'COIN_SELLER',
      'HOST',
    ];
    for (const role of mobileRoles) {
      const granted: string[] = DEFAULT_ROLE_PERMISSIONS[role as SystemRoleType] ?? [];
      expect(granted.filter((code) => code.startsWith('dashboard.'))).toEqual([]);
    }
  });
});
