import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');
const SCHEMA_DIR = join(SRC, '..', 'prisma', 'schema');

/**
 * Files that make authorisation, routing, eligibility or scope decisions. None
 * of them may read the free-text geography fields — those are for profile
 * display, timezone resolution, localisation and search only.
 */
const AUTHORISATION_CRITICAL_FILES = [
  'modules/mobile-workforce/services/workforce-scope.service.ts',
  'modules/mobile-workforce/services/mobile-workforce.service.ts',
  'modules/mobile-partner/services/mobile-partner.service.ts',
  'modules/authorization/services/geographic-scope-resolver.service.ts',
  'modules/authorization/services/permission-resolver.service.ts',
  'modules/authorization/services/role-resolver.service.ts',
  'modules/authorization/services/policy-engine.service.ts',
  'modules/enterprise-events/services/event-eligibility.service.ts',
  'modules/super-admin/services/role-assignment.service.ts',
  'modules/super-admin/services/account-lifecycle.service.ts',
  // NOT UserLocationService: its backfill reads the free-text profile country on
  // purpose, to seed the normalised column from it. It is a migration utility,
  // not an authorisation path — it decides nothing.
  'modules/dashboard-financial/services/dashboard-financial.service.ts',
  'modules/dashboard-operations/services/dashboard-operations.service.ts',
  'modules/dashboard-engagement/services/dashboard-engagement.service.ts',
  'modules/dashboard-moderation/services/dashboard-moderation.service.ts',
  'modules/analytics/services/aggregation.service.ts',
];

/**
 * Reading the free-text geography *off a user record* — `user.country`,
 * `user?.region`, `targetUser.country`.
 *
 * Deliberately narrow. `scope.country?.code` and `include: { country: true }`
 * read the `Country` *relation*, which is the normalised hierarchy and exactly
 * what these files should be using; flagging those would make the guard noise
 * and it would be switched off.
 */
const FREE_TEXT_GEOGRAPHY = /\b\w*[Uu]ser\w*\s*\??\.\s*(country|region)\b(?!Id|Code)/;

describe('normalised geography is the single source of truth', () => {
  it.each(AUTHORISATION_CRITICAL_FILES)('%s does not read free-text geography', (relative) => {
    const source = readFileSync(join(SRC, relative), 'utf8');

    const offending = source
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      // Comments explain why free text is avoided; they are not reads.
      .filter(
        ({ line }) => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'),
      )
      .filter(({ line }) => FREE_TEXT_GEOGRAPHY.test(line));

    expect(offending).toEqual([]);
  });
});

describe('Role Approval Engine will route on normalised geography', () => {
  it('RoleRequest carries normalised location ids and no free-text geography', () => {
    // The module is not built yet — no code, no migration. This asserts the
    // schema it will be built on already uses the hierarchy, so approval routing
    // cannot be written against free text later.
    const schema = readFileSync(join(SCHEMA_DIR, 'role_requests.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model RoleRequest {'));
    const body = model.slice(0, model.indexOf('\n}'));

    const fieldNames = body
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => /^[a-z][A-Za-z]*$/.test(name));

    expect(fieldNames).toEqual(expect.arrayContaining(['countryId', 'stateId', 'regionId']));
    expect(fieldNames).not.toContain('country');
    expect(fieldNames).not.toContain('region');
  });
});
