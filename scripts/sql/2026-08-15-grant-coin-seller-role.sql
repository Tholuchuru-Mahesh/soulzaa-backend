-- Grants an agency account the COIN_SELLER role, so the coin panel
-- (/admin/coin-seller/inventory/*) stops answering 403.
--
-- WHY THIS IS NEEDED
-- Permissions are resolved entirely from the database at request time:
-- user_roles -> role_permissions -> permissions. The ROLE_PERMISSIONS constant
-- in the codebase is only the seed source; editing it changes nothing in a
-- database that has already been seeded. COIN_SELLER is a role in its own
-- right ("activated inside an existing Agency account"), so holding AGENCY
-- does not imply it.
--
-- This script is idempotent — every step is ON CONFLICT DO NOTHING, so running
-- it twice grants nothing twice. It fixes all three links in one go:
--   1. the two inventory permissions exist
--   2. COIN_SELLER exists and is linked to them
--   3. the named user holds COIN_SELLER
--
-- USAGE — set the account first, then run the whole file:
--   \set target_username 'agency_username_here'
-- or edit the :'target_username' default below.
--
-- AFTERWARDS you MUST clear that user's cached permissions, or the old 403
-- answer is served from Redis until the TTL expires:
--   redis-cli DEL "rbac:perms:<userId>" "rbac:roles:<userId>"
-- The final SELECT prints the exact commands with the id filled in.

\set ON_ERROR_STOP on

-- Change this, or override with -v target_username=... on the psql command line.
\if :{?target_username}
\else
\set target_username 'CHANGE_ME'
\endif

BEGIN;

-- 1. The permissions themselves. Present on a freshly seeded database; created
--    here for one seeded before the coin panel existed.
INSERT INTO permissions (id, code, module, action, category, "displayName", description,
                         "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'coin_seller.inventory.purchase', 'coin_seller', 'manage', 'COIN_SELLER',
   'Purchase Inventory', 'Can purchase coin inventory from the platform', NOW(), NOW()),
  (gen_random_uuid(), 'coin_seller.inventory.sell', 'coin_seller', 'manage', 'COIN_SELLER',
   'Sell Inventory', 'Can sell coin inventory to users', NOW(), NOW())
ON CONFLICT (code) DO NOTHING;

-- 2. The role.
INSERT INTO roles (id, name, "displayName", description, "isSystem", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'COIN_SELLER', 'Coin Seller',
        'Agency account activated to buy and sell coin inventory', true, NOW(), NOW())
ON CONFLICT (name) DO NOTHING;

-- 3. Link the role to the permissions it needs for the panel. Both are
--    required: purchase covers the inventory/packages/history/checkout reads
--    and writes, sell covers sending coins on to a customer.
INSERT INTO role_permissions (id, "roleId", "permissionId", "createdAt")
SELECT gen_random_uuid(), r.id, p.id, NOW()
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'COIN_SELLER'
  AND p.code IN ('coin_seller.inventory.purchase', 'coin_seller.inventory.sell')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 4. Grant the role to the account.
INSERT INTO user_roles (id, "userId", "roleId", "createdAt", "updatedAt")
SELECT gen_random_uuid(), u.id, r.id, NOW(), NOW()
FROM users u
CROSS JOIN roles r
WHERE r.name = 'COIN_SELLER'
  AND (u.username = :'target_username' OR u.email = :'target_username')
ON CONFLICT ("userId", "roleId") DO NOTHING;

-- Refuse to commit a run that matched nobody, rather than reporting success
-- for a username that does not exist.
DO $$
DECLARE
  matched INT;
BEGIN
  SELECT COUNT(*) INTO matched
  FROM user_roles ur
  JOIN roles r ON r.id = ur."roleId"
  JOIN users u ON u.id = ur."userId"
  WHERE r.name = 'COIN_SELLER';

  IF matched = 0 THEN
    RAISE EXCEPTION 'No user now holds COIN_SELLER — check the username/email you passed';
  END IF;
END $$;

COMMIT;

-- What to run next. The grant is in the database, but the API will keep
-- answering 403 from the Redis cache until these keys are dropped.
-- Printed as the complete command, container prefix included, so it can be
-- copied verbatim rather than reassembled by hand.
SELECT
  u.id AS user_id,
  u.username,
  'docker exec -i soulzaa-redis redis-cli DEL "rbac:perms:' || u.id ||
    '" "rbac:roles:' || u.id || '"' AS run_this_next
FROM users u
JOIN user_roles ur ON ur."userId" = u.id
JOIN roles r ON r.id = ur."roleId"
WHERE r.name = 'COIN_SELLER'
  AND (u.username = :'target_username' OR u.email = :'target_username');
