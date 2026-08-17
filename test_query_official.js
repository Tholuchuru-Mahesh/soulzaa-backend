const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testList() {
  const official = await prisma.user.findFirst({ where: { username: 'e2e_official' } });
  console.log('OFFICIAL ID:', official.id);

  // Fixed query logic
  const where = {};
  const [total, rawItems] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { priority: 'desc' }],
      take: 25,
      skip: 0,
      select: {
        id: true,
        submitterId: true,
        title: true,
        description: true,
        category: true,
        priority: true,
        status: true,
        createdAt: true,
      }
    })
  ]);

  const submitterIds = Array.from(new Set(rawItems.map((item) => item.submitterId)));
  const users = submitterIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: submitterIds } },
        select: { id: true, username: true, fullName: true },
      })
    : [];

  const userMap = new Map(users.map((u) => [u.id, u]));

  const items = rawItems.map((item) => {
    const user = userMap.get(item.submitterId);
    return {
      ...item,
      submitter: user ? {
        id: user.id,
        username: user.username,
        name: user.fullName || user.username,
        avatarUrl: null,
      } : null,
    };
  });

  console.log('QUERY SUCCESS! TOTAL TICKETS:', total);
  console.log('ITEMS SAMPLE:', JSON.stringify(items.slice(0, 2), null, 2));
}

testList()
  .then(() => console.log('ALL GOOD!'))
  .catch(err => console.error('QUERY ERROR:', err))
  .finally(() => prisma.$disconnect());
