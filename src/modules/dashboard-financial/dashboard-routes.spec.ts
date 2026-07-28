import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from 'src/common/constants';
import { DashboardEngagementController } from '../dashboard-engagement/controllers/dashboard-engagement.controller';
import { DashboardModerationController } from '../dashboard-moderation/controllers/dashboard-moderation.controller';
import { DashboardOperationsController } from '../dashboard-operations/controllers/dashboard-operations.controller';
import { DashboardFinancialController } from './controllers/dashboard-financial.controller';

const reflector = new Reflector();

/** Handler names on a controller, excluding the constructor. */
function handlersOf(controller: new (...args: never[]) => object): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor');
}

/**
 * The web console is staff-only. That guarantee rests entirely on every route
 * carrying a `dashboard.*` permission — a handler that forgets one is reachable
 * by any authenticated user, including the seven mobile-only roles.
 *
 * Class-level `@RequirePermissions` covers the handlers, so this asserts the
 * effective permission the guard would read for each route.
 */
describe.each([
  ['financial', DashboardFinancialController, 'dashboard.financial.view'],
  ['operations', DashboardOperationsController, 'dashboard.operations.view'],
  ['engagement', DashboardEngagementController, 'dashboard.engagement.view'],
  ['moderation', DashboardModerationController, 'dashboard.moderation.view'],
] as Array<[string, new (...args: never[]) => object, string]>)(
  'dashboard-%s controller',
  (_name, controller, expectedPermission) => {
    it('declares its section permission at the class level', () => {
      expect(reflector.get<string[]>(PERMISSIONS_KEY, controller)).toEqual([expectedPermission]);
    });

    it('exposes at least one route', () => {
      expect(handlersOf(controller).length).toBeGreaterThan(0);
    });

    it.each(handlersOf(controller))('route %s resolves to the section permission', (handler) => {
      const proto = controller.prototype as Record<string, unknown>;
      // getAllAndOverride is what the guard uses: handler metadata wins, else class.
      const effective = reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
        proto[handler] as never,
        controller,
      ]);
      expect(effective).toEqual([expectedPermission]);
    });
  },
);

describe('web console route coverage', () => {
  it('covers all twenty named dashboard sections across four modules', () => {
    const routeCount = [
      DashboardFinancialController,
      DashboardOperationsController,
      DashboardEngagementController,
      DashboardModerationController,
    ].reduce((total, controller) => total + handlersOf(controller).length, 0);

    // 7 financial + 6 operations + 7 engagement + 2 moderation.
    expect(routeCount).toBe(22);
  });
});
