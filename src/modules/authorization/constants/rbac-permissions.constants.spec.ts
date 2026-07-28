import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { DEFAULT_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from './rbac-permissions.constants';

const MODULES_ROOT = join(__dirname, '../../..', 'modules');

/** Every `.controller.ts` under src/modules, recursively. */
function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...controllerFiles(full));
    } else if (entry.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Permission codes a controller actually enforces via @RequirePermissions(...). */
function enforcedCodes(source: string): string[] {
  const codes: string[] = [];
  for (const call of source.matchAll(/RequirePermissions\(([^)]*)\)/g)) {
    for (const literal of call[1].matchAll(/'([^']+)'/g)) {
      codes.push(literal[1]);
    }
  }
  return codes;
}

describe('RBAC permission catalogue', () => {
  const enforced = new Set<string>();
  const codeOwner = new Map<string, string>();

  beforeAll(() => {
    for (const file of controllerFiles(MODULES_ROOT)) {
      for (const code of enforcedCodes(readFileSync(file, 'utf8'))) {
        enforced.add(code);
        if (!codeOwner.has(code)) codeOwner.set(code, file.replace(MODULES_ROOT, ''));
      }
    }
  });

  it('finds permission codes to check (guards against a broken scanner)', () => {
    expect(enforced.size).toBeGreaterThan(100);
  });

  it('defines every permission code that a controller enforces', () => {
    const defined = new Set(DEFAULT_PERMISSIONS.map((p) => p.code));
    const undefinedCodes = [...enforced]
      .filter((code) => !defined.has(code))
      .sort()
      .map((code) => `${code}  (enforced by ${codeOwner.get(code)})`);

    // An enforced-but-undefined code can never be granted to any role, so the
    // endpoint is unreachable by everyone except the SUPER_ADMIN wildcard.
    expect(undefinedCodes).toEqual([]);
  });

  it('grants no permission that is absent from the catalogue', () => {
    const defined = new Set(DEFAULT_PERMISSIONS.map((p) => p.code));
    const danglingGrants: string[] = [];

    for (const [role, codes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const code of codes) {
        if (code !== '*' && !defined.has(code)) danglingGrants.push(`${role} -> ${code}`);
      }
    }

    expect(danglingGrants).toEqual([]);
  });

  it('is the only place the seed data is declared', () => {
    // prisma/seed-rbac.ts previously kept its own copy, which drifted: it granted
    // ADMIN 49 permissions while the bootstrap seeder granted 23. Whichever ran
    // last silently decided what an Admin could do.
    const seedScript = readFileSync(join(__dirname, '../../../..', 'prisma/seed-rbac.ts'), 'utf8');
    const ownDeclarations = [
      'DEFAULT_PERMISSIONS =',
      'DEFAULT_ROLE_PERMISSIONS =',
      'SYSTEM_ROLES =',
    ];

    expect(ownDeclarations.filter((decl) => seedScript.includes(decl))).toEqual([]);
  });

  it('declares a unique code for each permission', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const p of DEFAULT_PERMISSIONS) {
      if (seen.has(p.code)) duplicates.push(p.code);
      seen.add(p.code);
    }
    expect(duplicates).toEqual([]);
  });
});
