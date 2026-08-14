"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const DEAD_GAMES = [
    client_1.GameCode.GREEDY,
    client_1.GameCode.JACKPOT,
    client_1.GameCode.ROULETTE,
    client_1.GameCode.SLOTS,
    client_1.GameCode.DOMINO,
    client_1.GameCode.UNO,
];
async function main() {
    const result = await prisma.gameDefinition.updateMany({
        where: { code: { in: DEAD_GAMES } },
        data: { enabled: false },
    });
    console.log(`Disabled ${result.count} dead game definition row(s).`);
    const remaining = await prisma.gameDefinition.findMany({
        where: { enabled: true },
        select: { code: true, name: true },
        orderBy: { code: 'asc' },
    });
    console.log('Enabled catalog now:', remaining.map((d) => `${d.code} (${d.name})`).join(', ') || '(none)');
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
//# sourceMappingURL=disable_dead_games.js.map