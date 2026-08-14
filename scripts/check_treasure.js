"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    console.log('Checking Treasure Box Configs in database...');
    const configs = await prisma.treasureBoxConfig.findMany({
        orderBy: { level: 'asc' },
    });
    console.log(`Found ${configs.length} TreasureBoxConfig rows:`);
    for (const c of configs) {
        console.log(` Level ${c.level}: Threshold=${c.threshold}, enabled=${c.enabled}`);
    }
    const activeSessions = await prisma.treasureSession.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
    });
    console.log(`\nFound ${activeSessions.length} TreasureSession rows:`);
    for (const s of activeSessions) {
        console.log(` Session ID: ${s.id} | Room ID: ${s.roomId} | Status: ${s.status} | CurrentLevel: ${s.currentLevel} | CreatedAt: ${s.createdAt}`);
    }
    const boxes = await prisma.treasureBox.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
    });
    console.log(`\nFound ${boxes.length} TreasureBox rows:`);
    for (const b of boxes) {
        console.log(` Box ID: ${b.id} | Level: ${b.level} | Status: ${b.status} | Progress: ${b.progress} | Threshold: ${b.threshold}`);
    }
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
//# sourceMappingURL=check_treasure.js.map