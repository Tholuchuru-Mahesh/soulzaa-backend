import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { DEFAULT_PLATFORM_SETTINGS } from './platform-configuration-seeder.service';

const MODULES_ROOT = join(__dirname, '../../..', 'modules');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/**
 * Keys a module reads through ConfigurationEngineService, IPlatformConfiguration,
 * or PLATFORM_CONFIG. Scans for both direct call-site literals and keys defined
 * in constants objects ending in _CONFIG_KEYS.
 */
function configuredKeys(source: string): string[] {
  const keys: string[] = [];

  // Source 1: Direct call-site literals (.get<type>('literal-key'))
  // Only scan files that reference the config port
  if (
    source.includes('ConfigurationEngineService') ||
    source.includes('IPlatformConfiguration') ||
    source.includes('PLATFORM_CONFIG')
  ) {
    for (const call of source.matchAll(/\.get<[^>]*>\(\s*'([a-z][a-z0-9_.]*)'/g)) {
      keys.push(call[1]);
    }
  }

  // Source 2: Keys from constant objects (e.g., ATTENDANCE_CONFIG_KEYS)
  // Scan all files independently for *_CONFIG_KEYS objects
  for (const constObj of source.matchAll(
    /(?:export\s+)?const\s+(\w*_CONFIG_KEYS)\s*=\s*\{([^}]*)\}/g,
  )) {
    const objBody = constObj[2];
    // Extract string values from the object: look for quoted strings
    for (const stringMatch of objBody.matchAll(/['"]([a-z][a-z0-9_.]*)['"]/g)) {
      keys.push(stringMatch[1]);
    }
  }

  return keys;
}

describe('platform configuration seed', () => {
  const read = new Map<string, string>();

  beforeAll(() => {
    for (const file of sourceFiles(MODULES_ROOT)) {
      for (const key of configuredKeys(readFileSync(file, 'utf8'))) {
        if (!read.has(key)) read.set(key, file.replace(MODULES_ROOT, ''));
      }
    }
  });

  it('finds configuration keys to check (guards against a broken scanner)', () => {
    expect(read.size).toBeGreaterThan(20);
  });

  it('seeds every setting a module reads', () => {
    // The PRD is explicit that no economy value may be hardcoded. An unseeded
    // key silently falls back to whatever literal sits next to the `??` in the
    // consuming service, which is invisible to the Super Admin panel.
    const seeded = new Set(DEFAULT_PLATFORM_SETTINGS.map((s) => s.key));
    const unseeded = [...read.keys()]
      .filter((key) => !seeded.has(key))
      .sort()
      .map((key) => `${key}  (read by ${read.get(key)})`);

    expect(unseeded).toEqual([]);
  });

  it('declares a unique key for each setting', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const s of DEFAULT_PLATFORM_SETTINGS) {
      if (seen.has(s.key)) duplicates.push(s.key);
      seen.add(s.key);
    }
    expect(duplicates).toEqual([]);
  });
});
