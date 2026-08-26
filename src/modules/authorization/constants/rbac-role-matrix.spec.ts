import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import {
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  SYSTEM_ROLES,
} from './rbac-permissions.constants';

const MODULES_ROOT = join(__dirname, '../../..', 'modules');

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

/** A controller that exposes platform-wide (cross-user) administrative routes. */
function isAdministrative(file: string): boolean {
  return file.includes('/super-admin/') || file.endsWith('-admin.controller.ts');
}

function enforcedCodes(source: string): string[] {
  const codes: string[] = [];
  for (const call of source.matchAll(/RequirePermissions\(([^)]*)\)/g)) {
    for (const literal of call[1].matchAll(/'([^']+)'/g)) codes.push(literal[1]);
  }
  return codes;
}

/**
 * Encodes the PRD "Soulzaaa Authority Matrix" (Super Admin vs Admin) and the
 * per-role Restrictions sections for Official, Moderator, Agency and Coin Seller.
 * Each expectation below cites the rule it enforces.
 */

/** Authority Matrix rows marked "❌ Cannot Modify" / "❌ Cannot Perform" for Admin. */
const SUPER_ADMIN_ONLY = [
  'admin.provision', // Admin accounts are created only by Super Admin (PRD §1)
  'config.settings.update', // Global Platform Settings / System Configuration
  'config.settings.reset',
  'config.flags.manage', // App Maintenance Mode
  'treasury.policies.update', // Platform financial policy
  'treasury.risk.manage', // Emergency Platform Shutdown
  'revenue.configuration.manage', // Revenue Sharing Configuration
  'coin.manage', // Coin Pricing
  'wealth.configuration.manage', // Wealth Level general configuration
  'wealth.level.downgrade.manage', // Wealth Level downgrade policy
  'role.manage', // Platform Security
  'role.hierarchy.manage',
  'permission.manage',
  'organization.country.manage', // Country/region configuration
  'organization.state.manage',
  'organization.region.manage',
];

/** "Officials cannot: Approve Moderators / BD / Agencies / Coin Sellers." */
const OFFICIAL_FORBIDDEN = [
  'agency.approve',
  'agency.reject',
  'seller.approve',
  'seller.reject',
  'user.ban', // "Officials cannot: Permanently Ban Users"
  'wallet.adjust', // "Modify Wallet Balances"
  'withdrawal.approve', // "Approve Withdrawals"
];

/** "Moderators cannot: Access Financial Data / View Wallet Information / ..." */
const MODERATOR_FORBIDDEN = [
  'wallet.view',
  'wallet.adjust',
  'wallet.transaction.view',
  'revenue.view',
  'agency.settlement.view',
  'coin_seller.settlement.view',
  'withdrawal.view',
  'withdrawal.approve',
  'purchase.order.view',
  'treasury.summary.view',
  'room.close', // "Moderators cannot: Lock rooms, Close rooms"
  'agency.approve', // "Moderators cannot: Approve any role"
  'seller.approve',
];

/** "Agency / Coin Seller cannot: Approve platform roles, Modify user wallets, ..." */
const AGENCY_FORBIDDEN = [
  'wallet.view', // guards the platform wallet admin API
  'wallet.adjust',
  'wallet.transaction.view',
  'user.ban',
  'room.mute',
  'agency.approve',
  'seller.approve',
  'gift.manage',
  'coin.manage',
  'revenue.view',
];

const grants = (role: keyof typeof SYSTEM_ROLES): string[] => DEFAULT_ROLE_PERMISSIONS[role] ?? [];

describe('RBAC role matrix (PRD Authority Matrix)', () => {
  it('gives SUPER_ADMIN the platform wildcard', () => {
    expect(grants('SUPER_ADMIN')).toEqual(['*']);
  });

  it('reserves Super-Admin-only authority to SUPER_ADMIN', () => {
    const leaks: string[] = [];
    for (const [role, codes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      if (role === SYSTEM_ROLES.SUPER_ADMIN) continue;
      for (const code of SUPER_ADMIN_ONLY) {
        if (codes.includes(code)) leaks.push(`${role} -> ${code}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('denies OFFICIAL the approvals and financial actions the PRD reserves upward', () => {
    const held = OFFICIAL_FORBIDDEN.filter((code) => grants('OFFICIAL').includes(code));
    expect(held).toEqual([]);
  });

  it('denies MODERATOR all financial visibility and room closure', () => {
    const held = MODERATOR_FORBIDDEN.filter((code) => grants('MODERATOR').includes(code));
    expect(held).toEqual([]);
  });

  it('denies AGENCY and COIN_SELLER platform wallet and approval authority', () => {
    const held = [
      ...AGENCY_FORBIDDEN.filter((c) => grants('AGENCY').includes(c)).map((c) => `AGENCY -> ${c}`),
      ...AGENCY_FORBIDDEN.filter((c) => grants('COIN_SELLER').includes(c)).map(
        (c) => `COIN_SELLER -> ${c}`,
      ),
    ];
    expect(held).toEqual([]);
  });

  it('gives ADMIN the operational modules the Authority Matrix marks ✅', () => {
    const required = [
      'user.list.view', // User Management
      'user.status.suspend',
      'user.role.assign', // Manager/Official/Moderator/BD management
      'workforce.list.view',
      'workforce.assign',
      'agency.approve', // Agency Management
      'seller.approve', // Coin Seller Management
      'gift.manage', // Content Management
      'badge.manage',
      'event.manage', // Event Management
      'task.manage', // Task Management
      'analytics.view', // Analytics Dashboard (operational)
      'audit.view', // Audit Logs (operational)
      'wallet.adjust', // Wallet Adjustment (within permission)
      'announcement.manage', // Platform Announcements (operational)
      'dashboard.view', // Operational console
    ];
    const missing = required.filter((code) => !grants('ADMIN').includes(code));
    expect(missing).toEqual([]);
  });

  it('gives COUNTRY_MANAGER regional supervision without platform configuration', () => {
    const required = ['user.list.view', 'workforce.list.view', 'analytics.view', 'ranking.view'];
    expect(required.filter((c) => !grants('COUNTRY_MANAGER').includes(c))).toEqual([]);
  });

  it('gives OFFICIAL regional visibility and event creation', () => {
    const required = ['user.view', 'agency.settlement.view', 'event.create', 'task.view'];
    expect(required.filter((c) => !grants('OFFICIAL').includes(c))).toEqual([]);
  });

  it('gives MODERATOR its moderation actions', () => {
    const required = ['user.view', 'room.mute', 'room.update'];
    expect(required.filter((c) => !grants('MODERATOR').includes(c))).toEqual([]);
  });

  it('gives AGENCY and COIN_SELLER visibility of their own settlements only', () => {
    expect(grants('AGENCY')).toContain('agency.settlement.view');
    expect(grants('COIN_SELLER')).toContain('coin_seller.settlement.view');
  });

  it('gives HOST and USER their member-facing permissions', () => {
    for (const role of ['HOST', 'USER'] as const) {
      const required = [
        'gift.send',
        'family.view',
        'wealth.view',
        'level.view',
        'achievement.view',
        'ranking.view',
        'event.view',
        'task.view',
        'referral.view',
        'notification.view',
        'withdrawal.request',
      ];
      expect({ role, missing: required.filter((c) => !grants(role).includes(c)) }).toEqual({
        role,
        missing: [],
      });
    }
  });

  it('never grants a member-tier role a permission that guards an administrative route', () => {
    const adminCodes = new Map<string, string>();
    for (const file of controllerFiles(MODULES_ROOT)) {
      if (!isAdministrative(file)) continue;
      for (const code of enforcedCodes(readFileSync(file, 'utf8'))) {
        if (!adminCodes.has(code)) adminCodes.set(code, file.replace(MODULES_ROOT, ''));
      }
    }

    const memberTier = ['USER', 'HOST', 'AGENCY', 'COIN_SELLER'] as const;
    const leaks: string[] = [];
    for (const role of memberTier) {
      for (const code of grants(role)) {
        if (adminCodes.has(code)) leaks.push(`${role} -> ${code} (guards ${adminCodes.get(code)})`);
      }
    }

    expect(leaks).toEqual([]);
  });

  it('defines a grant list for every system role', () => {
    const rolesWithoutGrants = Object.values(SYSTEM_ROLES).filter(
      (role) => !Array.isArray(DEFAULT_ROLE_PERMISSIONS[role]),
    );
    expect(rolesWithoutGrants).toEqual([]);
  });

  it('lets AGENCY author and submit events but never publish or manage them', () => {
    const agency = grants('AGENCY');
    expect(agency).toContain('event.create');
    expect(agency).toContain('event.submit_for_approval');
    // The whole point of the approval workflow: an agency cannot make an event live.
    expect(agency).not.toContain('event.publish');
    expect(agency).not.toContain('event.manage');
  });

  it('declares every permission granted to AGENCY', () => {
    const declared = new Set(DEFAULT_PERMISSIONS.map((p) => p.code));
    const undeclared = grants('AGENCY').filter((c) => !declared.has(c));
    expect(undeclared).toEqual([]);
  });
});
