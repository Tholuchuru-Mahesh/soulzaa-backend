import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallStatus, DirectMessageType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  CHAT_SERVICE,
  type IChatService,
} from 'src/modules/chat/interfaces/chat.service.interface';
import {
  CALL_EVENTS,
  type CallEndedEvent,
  type CallMissedEvent,
  type CallRejectedEvent,
} from '../events/calls.events';
import type { CallView } from '../interfaces/calls.service.interface';
import { CallRepository } from '../repositories/call.repository';

/**
 * Writes a finished call into the two users' DM thread as a `CALL_LOG` message —
 * the producer the `DirectMessageType.CALL_LOG` type has been waiting for.
 *
 * Only into a thread that **already exists**. `openDirect` would happily create one,
 * and that is precisely why it is not used: between strangers it would open a *chat
 * request*, so a missed call from someone you have never spoken to would put a
 * message request in your inbox on their behalf. A call is not a message, and it
 * must not become one.
 *
 * The message is authored by the caller, because that is who started the exchange —
 * the log renders from `metadata.outcome`, not from who sent it, so both sides see
 * "missed" or "12:04" rather than a bubble on one side of the thread.
 */
@Injectable()
export class CallsChatLogListener implements OnModuleInit {
  private readonly logger = new Logger(CallsChatLogListener.name);
  private readonly enabled: boolean;

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(CHAT_SERVICE) private readonly chat: IChatService,
    private readonly calls: CallRepository,
    config: ConfigService,
  ) {
    this.enabled = config.get<{ writeChatLog: boolean }>('calls', { infer: true })!.writeChatLog;
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.bus.subscribe<CallEndedEvent>(CALL_EVENTS.ENDED, (e) => this.log(e.payload.views));
    this.bus.subscribe<CallMissedEvent>(CALL_EVENTS.MISSED, (e) => this.log(e.payload.views));
    this.bus.subscribe<CallRejectedEvent>(CALL_EVENTS.REJECTED, (e) => this.log(e.payload.views));
  }

  private async log(views: Record<string, CallView>): Promise<void> {
    const call = Object.values(views)[0];
    if (!call) return;

    try {
      const conversation = await this.chat.findDirect(call.callerId, call.calleeId);
      if (!conversation) return; // No thread. See the class doc — we do not create one.

      await this.chat.sendMessage(call.callerId, conversation.id, {
        // Deterministic: the events are idempotent (a reaper and a job may both settle
        // one call), and chat dedupes on clientId, so a replay writes one message.
        clientId: `call:${call.id}`,
        type: DirectMessageType.CALL_LOG,
        content: '',
        metadata: {
          callId: call.id,
          callType: call.type,
          durationSeconds: call.durationSeconds,
          outcome: this.outcomeOf(call.status),
        },
      });

      await this.calls.setConversation(call.id, conversation.id);
    } catch (err) {
      // A call that happened is not undone by a log line that did not. Never let this
      // fail the call — the ledger row is the Call table, and this is a convenience.
      this.logger.warn(`could not write CALL_LOG for call ${call.id}: ${(err as Error).message}`);
    }
  }

  /** What the bubble renders. Distinct from `status` so the client never switches on a DB enum. */
  private outcomeOf(status: CallStatus): string {
    switch (status) {
      case CallStatus.ENDED:
        return 'COMPLETED';
      case CallStatus.MISSED:
        return 'MISSED';
      case CallStatus.REJECTED:
        return 'DECLINED';
      default:
        return status;
    }
  }
}
