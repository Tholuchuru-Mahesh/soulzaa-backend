import { Global, Module } from '@nestjs/common';
import { LuckyPacketController } from './controllers/lucky-packet.controller';
import { LUCKY_PACKETS_SERVICE } from './interfaces/lucky-packets.service.interface';
import { LuckyPacketRepository } from './repositories/lucky-packet.repository';
import { LuckyPacketExpiryMonitor } from './services/lucky-packet-expiry.monitor';
import { LuckyPacketService } from './services/lucky-packet.service';

/**
 * Lucky Packets (AR-14) — host-funded coin "red envelopes" in an audio room. A
 * host debits their wallet to create a packet with N winner slots; members claim
 * a server-computed share (RANDOM/FIXED). Idempotent wallet movement + a
 * per-packet lock + a DB unique constraint make claims exactly-once. Unclaimed
 * coins are refunded on expiry by a fleet-wide monitor. Realtime fan-out flows
 * through EVENT_BUS → the audio-rooms lucky-packet socket bridge.
 *
 * @Global so the read seam (LUCKY_PACKETS_SERVICE) is resolvable by later
 * contexts without importing this module.
 */
@Global()
@Module({
  controllers: [LuckyPacketController],
  providers: [
    LuckyPacketRepository,
    LuckyPacketService,
    LuckyPacketExpiryMonitor,
    { provide: LUCKY_PACKETS_SERVICE, useExisting: LuckyPacketService },
  ],
  exports: [LUCKY_PACKETS_SERVICE],
})
export class LuckyPacketsModule {}
