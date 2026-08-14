"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const prisma = new client_1.PrismaClient();
async function main() {
    let dbUser = await prisma.user.findFirst();
    let user;
    if (!dbUser) {
        console.log('No user found! Creating a test user first...');
        const mobile = '+919030996071';
        const username = 'testuser';
        user = await prisma.$transaction(async (tx) => {
            const u = await tx.user.create({
                data: {
                    username,
                    mobile,
                    fullName: 'Test User',
                    country: 'IN',
                    preferredLanguage: 'en',
                    mobileVerifiedAt: new Date(),
                },
            });
            await tx.userProfile.create({ data: { userId: u.id } });
            await tx.userStatistics.create({ data: { userId: u.id } });
            await tx.userVerification.create({ data: { userId: u.id } });
            return u;
        });
        console.log(`Created test user: ${user.id}`);
    }
    else {
        user = dbUser;
        console.log(`Using existing user: ${user.id} (${user.username})`);
    }
    let category = await prisma.roomCategory.findFirst();
    if (!category) {
        console.log('No room category found! Creating one...');
        category = await prisma.roomCategory.create({
            data: {
                name: 'Chat & Friends',
                slug: 'chat',
                sortOrder: 1,
                isActive: true,
            },
        });
    }
    console.log(`Using category: ${category.id} (${category.name})`);
    const liveRooms = await prisma.audioRoom.findMany({
        where: { status: 'LIVE' },
    });
    console.log(`Found ${liveRooms.length} live rooms in DB.`);
    if (liveRooms.length === 0) {
        console.log('Creating a default live audio room for testing...');
        const roomId = (0, crypto_1.randomUUID)();
        const agoraChannel = `room_${roomId.substring(0, 8)}`;
        const zegoRoomId = `zego_${roomId.substring(0, 8)}`;
        const room = await prisma.$transaction(async (tx) => {
            const r = await tx.audioRoom.create({
                data: {
                    id: roomId,
                    ownerId: user.id,
                    name: 'Welcome to Soulzaa! 🎉',
                    description: 'A cozy space to hang out, chat, and listen to music.',
                    categoryId: category.id,
                    language: 'en',
                    visibility: 'PUBLIC',
                    maxParticipants: 50,
                    status: 'LIVE',
                    agoraChannel,
                    zegoRoomId,
                },
            });
            await tx.roomSettings.create({
                data: {
                    roomId: r.id,
                    speakerSeatCount: 8,
                    premiumAdminSeatCount: 0,
                },
            });
            await tx.roomMember.create({
                data: {
                    roomId: r.id,
                    userId: user.id,
                    role: 'OWNER',
                    isActive: true,
                },
            });
            return r;
        });
        console.log(`Successfully created live room: ${room.id}`);
        console.log(`agoraChannel: ${room.agoraChannel}, zegoRoomId: ${room.zegoRoomId}`);
    }
    else {
        console.log('Live rooms present:');
        for (const r of liveRooms) {
            console.log(`- Room "${r.name}" (${r.id}), owner: ${r.ownerId}, status: ${r.status}`);
        }
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
//# sourceMappingURL=check_rooms.js.map