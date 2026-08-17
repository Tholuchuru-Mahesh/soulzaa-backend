const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const officialRole = await prisma.role.findFirst({ where: { name: 'OFFICIAL' } });
  if (!officialRole) return;

  let perm = await prisma.permission.findFirst({
    where: { code: 'mobile.workforce.view' },
  });
  if (!perm) {
    perm = await prisma.permission.create({
      data: {
        code: 'mobile.workforce.view',
        module: 'mobile_workforce',
        action: 'view',
        category: 'SYSTEM',
        displayName: 'View Mobile Workforce Console',
        description: 'Access to mobile workforce regional operations dashboard',
      },
    });
    console.log('Created permission mobile.workforce.view');
  }

  const existingRolePerm = await prisma.rolePermission.findFirst({
    where: { roleId: officialRole.id, permissionId: perm.id },
  });
  if (!existingRolePerm) {
    await prisma.rolePermission.create({
      data: { roleId: officialRole.id, permissionId: perm.id },
    });
    console.log('Linked mobile.workforce.view to OFFICIAL role!');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
