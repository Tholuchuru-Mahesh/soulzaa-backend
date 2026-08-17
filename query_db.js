const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tickets = await prisma.supportTicket.findMany();
  console.log('TICKET_COUNT:', tickets.length);
  console.log('TICKETS:', JSON.stringify(tickets, null, 2));
}

main().catch(console.error).finally(async () => {
  await prisma.$disconnect();
});
