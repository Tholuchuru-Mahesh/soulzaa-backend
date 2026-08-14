"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    const apply = process.argv.includes('--apply');
    const packages = await prisma.coinPackage.findMany({
        where: { googleProductId: null },
        select: { id: true, code: true },
    });
    for (const pkg of packages) {
        const productId = pkg.code.toLowerCase();
        if (!/^[a-z0-9][a-z0-9_.]*$/.test(productId)) {
            throw new Error(`Code '${pkg.code}' does not lowercase into a valid Play product ID`);
        }
        console.log(`${apply ? 'SET' : 'WOULD SET'} ${pkg.code} -> ${productId}`);
        if (apply) {
            await prisma.coinPackage.update({
                where: { id: pkg.id },
                data: { googleProductId: productId },
            });
        }
    }
    console.log(`${packages.length} package(s) ${apply ? 'updated' : 'pending'}`);
}
main()
    .catch((err) => {
    console.error(err);
    process.exitCode = 1;
})
    .finally(() => prisma.$disconnect());
//# sourceMappingURL=backfill-google-product-ids.js.map