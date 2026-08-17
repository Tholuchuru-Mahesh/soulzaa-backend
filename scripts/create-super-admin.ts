import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

/**
 * Creates (or repairs) a SUPER_ADMIN staff account.
 *
 * Written because staff login has five gates in front of it and an account
 * that looks correct in the `users` table can still be rejected by all of
 * them. This script sets up every piece the login path actually reads:
 *
 *   1. `User`            — the identity row, ACTIVE and hidden from public lists
 *   2. `UserCredential`  — the bcrypt hash; `User` has no password column
 *   3. `UserRole`        — the RBAC assignment, with `suspendedAt` cleared
 *
 * Point 3 is the one that most often bites. `staffLogin` resolves roles through
 * `RoleResolverService.getRoleNames`, which reads the RBAC `user_roles` table
 * and nothing else. The legacy `users.roles` array — which its own schema
 * comment says is being retired — is invisible to it, so an account whose
 * SUPER_ADMIN lives only there is rejected as "not staff".
 *
 * Safe to re-run: every write is an upsert, so this repairs a half-built
 * account rather than duplicating it.
 *
 * Usage:
 *   SUPER_ADMIN_EMAIL=you@example.com \
 *   SUPER_ADMIN_PASSWORD='choose-a-strong-one' \
 *   npx ts-node -r tsconfig-paths/register scripts/create-super-admin.ts
 *
 * The password is read from the environment on purpose: a password written
 * into a file ends up in git history and in your shell history.
 */
const prisma = new PrismaClient();

const ROLE_NAME = 'SUPER_ADMIN';
const SALT_ROUNDS = 12;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. See the usage comment at the top of this file.`);
  }
  return value;
}

async function main(): Promise<void> {
  const email = required('SUPER_ADMIN_EMAIL').toLowerCase();
  const password = required('SUPER_ADMIN_PASSWORD');
  const username = (process.env.SUPER_ADMIN_USERNAME ?? email.split('@')[0]).trim();

  if (password.length < 12) {
    throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters.');
  }

  // The role has to exist before anything is assigned to it. If it does not,
  // RBAC was never seeded and creating the user first would leave a half-built
  // account that fails login with a confusing "not staff" error.
  const role = await prisma.role.findUnique({ where: { name: ROLE_NAME } });
  if (!role) {
    throw new Error(
      `Role ${ROLE_NAME} does not exist. Run the RBAC seed first:\n` +
        '  npx ts-node -r tsconfig-paths/register prisma/seed-rbac.ts',
    );
  }

  const passwordHash = await hash(password, SALT_ROUNDS);

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      username,
      status: 'ACTIVE',
      // Staff accounts must never appear in member lists, directories or
      // search. This is the column the read paths filter on.
      isHiddenAccount: true,
      emailVerifiedAt: new Date(),
    },
    // Deliberately narrow: re-running must not rename an existing account or
    // silently un-suspend one somebody disabled on purpose.
    update: { isHiddenAccount: true },
  });

  // Credentials live on UserCredential, not on User.
  await prisma.userCredential.upsert({
    where: { userId: user.id },
    create: { userId: user.id, passwordHash, passwordUpdatedAt: new Date() },
    update: { passwordHash, passwordUpdatedAt: new Date() },
  });

  // `getDirectUserRoles` filters on `suspendedAt: null`, so a suspended row is
  // invisible to login. Clearing it is what repairs an account that was
  // suspended by the moderator-management feature.
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    create: { userId: user.id, roleId: role.id },
    update: { suspendedAt: null, suspendedBy: null },
  });

  console.log('');
  console.log(`  SUPER_ADMIN ready`);
  console.log(`  email     ${email}`);
  console.log(`  username  ${username}`);
  console.log(`  user id   ${user.id}`);
  console.log('');
  console.log('  Sign in at  POST /staff/auth/login  with { email, password }.');
  console.log('  Your first login registers your current IP on the staff allowlist;');
  console.log('  logging in later from a different network will be refused until that');
  console.log('  IP is added too.');
  console.log('');
}

main()
  .catch((err: unknown) => {
    console.error(`\n  Failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
