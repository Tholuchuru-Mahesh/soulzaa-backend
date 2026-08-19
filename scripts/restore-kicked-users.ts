import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

async function main() {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  try {
    console.log('Restoring all currently active room kicks...');
    const activeKicks = await prisma.roomKick.findMany({
      where: { status: 'ACTIVE' },
    });

    console.log(`Found ${activeKicks.length} active room kicks in database.`);

    for (const kick of activeKicks) {
      await prisma.roomKick.update({
        where: { id: kick.id },
        data: {
          status: 'LIFTED',
          liftedAt: new Date(),
        },
      });

      try {
        const kickSetKey = `audio_room:${kick.roomId}:kicks`;
        const kickKey = `audio_room:${kick.roomId}:kick:${kick.userId}`;
        await redis.srem(kickSetKey, kick.userId);
        await redis.del(kickKey);
      } catch (err) {
        console.warn('Redis key cleanup warning (non-fatal):', err);
      }
      console.log(`Restored user ${kick.userId} in room ${kick.roomId}.`);
    }

    const result = await prisma.roomKick.updateMany({
      where: { status: 'ACTIVE' },
      data: {
        status: 'LIFTED',
        liftedAt: new Date(),
      },
    });

    console.log(`Successfully updated active room kicks to LIFTED (${result.count} total records).`);
  } catch (error) {
    console.error('Error during kick restoration:', error);
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main();
