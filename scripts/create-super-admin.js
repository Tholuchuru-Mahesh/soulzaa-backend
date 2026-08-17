/**
 * Creates (or repairs) a SUPER_ADMIN staff account — production-runnable twin
 * of `create-super-admin.ts`.
 *
 * Plain JavaScript on purpose. The production image drops `ts-node` and
 * `tsconfig-paths` (`pnpm prune --prod`) and never copies `scripts/` at all, so
 * the TypeScript version cannot run there. `bcryptjs` and `@prisma/client` are
 * production dependencies, so this file runs inside the api container as-is:
 *
 *   docker compose -f docker-compose.prod.yml exec -T api sh -c 'cat > /tmp/csa.js'  < scripts/create-super-admin.js
 *   docker compose -f docker-compose.prod.yml exec \
 *     -e SUPER_ADMIN_EMAIL=you@example.com \
 *     -e SUPER_ADMIN_PASSWORD="$NEW_PASSWORD" \
 *     api node /tmp/csa.js
 *
 * It writes the three places staff login actually reads:
 *
 *   1. `users`             — ACTIVE, and hidden from public member lists
 *   2. `user_credentials`  — the bcrypt hash; `users` has no password column
 *   3. `user_roles`        — the RBAC assignment, with `suspendedAt` cleared
 *
 * Point 3 is the usual cause of "the account exists but cannot log in".
 * `staffLogin` resolves roles via `RoleResolverService.getRoleNames`, which
 * reads `user_roles` and nothing else — the legacy `users.roles` array is
 * invisible to it.
 *
 * Safe to re-run: every write is an upsert, so it repairs rather than
 * duplicates.
 */
const { PrismaClient } = require('@prisma/client');
const { hash } = require('bcryptjs');

const prisma = new PrismaClient();

const ROLE_NAME = 'SUPER_ADMIN';
const SALT_ROUNDS = 12;

function required(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required. See the usage comment at the top of this file.`);
  }
  return value;
}

async function main() {
  const email = required('SUPER_ADMIN_EMAIL').toLowerCase();
  const password = required('SUPER_ADMIN_PASSWORD');
  const username = (process.env.SUPER_ADMIN_USERNAME || email.split('@')[0]).trim();

  if (password.length < 12) {
    throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters.');
  }

  // Checked before any write: creating the user first would leave a half-built
  // account that fails login with a confusing "not staff" error.
  const role = await prisma.role.findUnique({ where: { name: ROLE_NAME } });
  if (!role) {
    throw new Error(
      `Role ${ROLE_NAME} does not exist — RBAC was never seeded on this database.`,
    );
  }

  const passwordHash = await hash(password, SALT_ROUNDS);

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      username,
      status: 'ACTIVE',
      // Staff accounts must never surface in member lists or search.
      isHiddenAccount: true,
      emailVerifiedAt: new Date(),
    },
    // Deliberately narrow: re-running must not rename an existing account or
    // silently re-enable one somebody disabled on purpose.
    update: { isHiddenAccount: true },
  });

  await prisma.userCredential.upsert({
    where: { userId: user.id },
    create: { userId: user.id, passwordHash, passwordUpdatedAt: new Date() },
    update: { passwordHash, passwordUpdatedAt: new Date() },
  });

  // `getDirectUserRoles` filters on `suspendedAt: null`, so a suspended row is
  // invisible to login. Clearing it repairs an account suspended by the
  // moderator-management feature.
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    create: { userId: user.id, roleId: role.id },
    update: { suspendedAt: null, suspendedBy: null },
  });

  console.log('');
  console.log('  SUPER_ADMIN ready');
  console.log(`  email     ${email}`);
  console.log(`  username  ${username}`);
  console.log(`  user id   ${user.id}`);
  console.log('');
  console.log('  Sign in at  POST /staff/auth/login  with { email, password }.');
  console.log('  Your first login registers that IP on the staff allowlist; logging in');
  console.log('  later from a different network is refused until that IP is added too.');
  console.log('');
}

main()
  .catch((err) => {
    console.error(`\n  Failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
