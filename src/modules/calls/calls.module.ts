import { BullModule } from '@nestjs/bullmq';
import { Global, Module, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { CALL_JOBS, CALL_QUEUES } from './constants/calls.constants';
import { CallsController } from './controllers/calls.controller';
import { CALLS_SERVICE } from './interfaces/calls.service.interface';
import { CallsChatLogListener } from './listeners/calls-chat-log.listener';
import { CallsPushListener } from './listeners/calls-push.listener';
import { CallsSocketListener } from './listeners/calls-socket.listener';
import { CallDeadlineProcessor } from './processors/call-deadline.processor';
import { CallRepository } from './repositories/call.repository';
import { CallViewMapper } from './services/call-view.mapper';
import { CallsService } from './services/calls.service';

/**
 * Calls domain — private 1:1 voice and video. Owns the `calls` table and the call
 * lifecycle: invitation, the accept/reject/cancel race, ring and connect deadlines,
 * ZEGO token issuance, and history.
 *
 * Consumes PRIVACY_SERVICE (the `CALL` gate + block list), PROFILE_SERVICE (peer
 * card hydration + history search), ZegoTokenService (room tokens), DEVICE_SERVICE
 * (ringing a backgrounded phone), NOTIFICATION_SERVICE (the durable missed-call
 * row) and CHAT_SERVICE (writing the finished call into the DM thread as a
 * CALL_LOG). Media never touches this server — ZEGO carries it peer-to-peer, and
 * this module only signals.
 *
 * Registers its own `calls` BullMQ queue off the shared connection, so a ring
 * timeout is never queued behind someone else's slow job.
 *
 * @Global so consumers resolve CALLS_SERVICE by token without importing this module.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: CALL_QUEUES.CALLS })],
  controllers: [CallsController],
  providers: [
    // repositories
    CallRepository,
    // services
    CallViewMapper,
    CallsService,
    // listeners
    CallsSocketListener,
    CallsPushListener,
    CallsChatLogListener,
    // workers
    CallDeadlineProcessor,
    // public token
    { provide: CALLS_SERVICE, useExisting: CallsService },
  ],
  exports: [CALLS_SERVICE],
})
export class CallsModule implements OnModuleInit {
  constructor(
    @InjectQueue(CALL_QUEUES.CALLS) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  /**
   * Arm the reaper. The per-call delayed jobs are the fast path; this repeatable
   * sweep is what makes a *lost* job survivable rather than fatal — without it, a
   * worker that dies between arming a ring timeout and running it would leave a
   * phone ringing forever, and a `RINGING` row nothing would ever settle.
   */
  async onModuleInit(): Promise<void> {
    const { reaperIntervalSeconds } = this.config.get<{ reaperIntervalSeconds: number }>('calls', {
      infer: true,
    })!;
    await this.queue.add(
      CALL_JOBS.REAP,
      {},
      {
        repeat: { every: reaperIntervalSeconds * 1000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }
}
