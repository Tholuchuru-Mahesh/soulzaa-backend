import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { PUSH_CATEGORIES, PUSH_CHANNELS } from 'src/modules/device/interfaces/push.constants';
import { DeviceRepository } from 'src/modules/device/repositories/device.repository';
import { PushDispatcher } from 'src/modules/device/services/push/push.dispatcher';
import { ConsoleEmailProvider } from 'src/modules/otp/services/providers/console-email.provider';
import { SmsProviderRegistry } from 'src/modules/otp/services/providers/sms-provider.registry';

export interface ChannelDispatchContext {
  notificationId: string;
  recipientId?: string;
  title?: string;
  body?: string;
  variables?: Record<string, string>;
}

export interface ChannelDispatchResult {
  success: boolean;
  errorMessage?: string;
}

/**
 * Delivers a notification over a concrete transport.
 *
 * Each channel routes to the transport the platform already owns — the push
 * dispatcher (FCM/APNs), the SMS/email providers, and the socket manager —
 * rather than re-implementing them. Previously every channel logged a line and
 * returned success, so delivery statistics and history counted sends that never
 * left the process.
 *
 * IN_APP is not delivered here: the inbox row is written by the dispatch service.
 */
@Injectable()
export class NotificationChannelService {
  private readonly logger = new Logger(NotificationChannelService.name);

  private readonly channels = new Set<string>(['IN_APP', 'PUSH', 'WEBSOCKET', 'EMAIL', 'SMS']);

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DeviceRepository,
    private readonly push: PushDispatcher,
    private readonly sockets: SocketManager,
    private readonly smsProviders: SmsProviderRegistry,
    private readonly email: ConsoleEmailProvider,
  ) {}

  registerChannel(channel: string): void {
    this.channels.add(channel.toUpperCase());
    this.logger.log(`Channel registered: ${channel}`);
  }

  isChannelRegistered(channel: string): boolean {
    return this.channels.has(channel.toUpperCase());
  }

  async dispatchToChannel(
    channel: string,
    ctx: ChannelDispatchContext,
  ): Promise<ChannelDispatchResult> {
    const name = channel.toUpperCase();
    if (!this.isChannelRegistered(name)) {
      return { success: false, errorMessage: `Channel ${channel} is not registered.` };
    }

    try {
      switch (name) {
        case 'IN_APP':
          // The inbox row is written by the dispatch service.
          return { success: true };
        case 'WEBSOCKET':
          return this.viaWebsocket(ctx);
        case 'PUSH':
          return await this.viaPush(ctx);
        case 'EMAIL':
          return await this.viaEmail(ctx);
        case 'SMS':
          return await this.viaSms(ctx);
        default:
          // Registered at runtime with no transport wired — not a silent success.
          return {
            success: false,
            errorMessage: `Channel ${name} has no delivery transport configured.`,
          };
      }
    } catch (err) {
      return { success: false, errorMessage: (err as Error).message };
    }
  }

  private viaWebsocket(ctx: ChannelDispatchContext): ChannelDispatchResult {
    if (!ctx.recipientId) {
      return { success: false, errorMessage: 'WEBSOCKET delivery requires a recipient.' };
    }
    this.sockets.emitToUserEverywhere(ctx.recipientId, 'notification.delivered', {
      notificationId: ctx.notificationId,
      title: ctx.title,
      body: ctx.body,
    });
    return { success: true };
  }

  private async viaPush(ctx: ChannelDispatchContext): Promise<ChannelDispatchResult> {
    if (!ctx.recipientId) {
      return { success: false, errorMessage: 'PUSH delivery requires a recipient.' };
    }

    const tokens = await this.devices.pushTokensForUser(ctx.recipientId);
    if (tokens.length === 0) {
      // Not a transport fault, but still a non-delivery — must not count as sent.
      return { success: false, errorMessage: 'Recipient has no registered push tokens.' };
    }

    // Enterprise notifications ride the default channel with the SYSTEM category.
    // Per-category channels (and the tone-suffixed ids `PushPolicy` builds) are
    // driven by the device module's preference model, which is separate from the
    // Notification Center's; routing by category means reconciling the two first.
    // Preference gating still happens — the dispatch service applies this
    // module's own opt-outs before a channel is ever reached.
    const result = await this.push.sendToTokens(
      tokens.map((t) => t.pushToken),
      {
        title: ctx.title ?? '',
        body: ctx.body ?? '',
        data: { notificationId: ctx.notificationId },
        category: PUSH_CATEGORIES.SYSTEM,
        channelId: PUSH_CHANNELS.DEFAULT,
      },
    );

    return result.delivered > 0
      ? { success: true }
      : { success: false, errorMessage: `Push failed for all ${result.failed} token(s).` };
  }

  private async viaEmail(ctx: ChannelDispatchContext): Promise<ChannelDispatchResult> {
    if (!ctx.recipientId) {
      return { success: false, errorMessage: 'EMAIL delivery requires a recipient.' };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: ctx.recipientId },
      select: { email: true },
    });
    if (!user?.email) {
      return { success: false, errorMessage: 'Recipient has no email address.' };
    }

    await this.email.send(user.email, ctx.title ?? 'Soulzaa', ctx.body ?? '');
    return { success: true };
  }

  private async viaSms(ctx: ChannelDispatchContext): Promise<ChannelDispatchResult> {
    if (!ctx.recipientId) {
      return { success: false, errorMessage: 'SMS delivery requires a recipient.' };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: ctx.recipientId },
      select: { mobile: true },
    });
    if (!user?.mobile) {
      return { success: false, errorMessage: 'Recipient has no mobile number.' };
    }

    const text = [ctx.title, ctx.body].filter(Boolean).join(': ');
    await this.smsProviders.resolve().send(user.mobile, text);
    return { success: true };
  }
}
