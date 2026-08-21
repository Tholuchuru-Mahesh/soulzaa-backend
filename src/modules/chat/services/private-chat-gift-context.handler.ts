import { HttpStatus, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { GiftContextRegistry } from 'src/modules/gifts/services/gift-context.registry';
import type {
  GiftContextRequest,
  IGiftContextHandler,
} from 'src/modules/gifts/interfaces/gift-context-handler.interface';
import { PRIVACY_SERVICE, type IPrivacyService } from 'src/modules/privacy/interfaces';
import { CHAT_SERVICE, type IChatService } from '../interfaces';

/**
 * Gifting inside a one-to-one conversation (`GiftContextType.PRIVATE_CHAT`).
 *
 * This handler exists primarily to *close an authorization hole*, not to add a
 * feature. `GiftContextRegistry.for()` falls back to a permissive default
 * handler — no-op `validate()`, `maxReceivers: 100` — for any context nobody
 * registered. Until this class existed, a client could send
 * `contextType: PRIVATE_CHAT` with any UUID it liked and the send would go
 * through unchecked: no conversation had to exist, the sender did not have to be
 * in it, and a block did not stop it.
 *
 * The rules mirror the room handlers as closely as the context allows: the
 * sender must be in the conversation, the receiver must be in the *same*
 * conversation, and a block either way ends it.
 */
@Injectable()
export class PrivateChatGiftContextHandler implements IGiftContextHandler, OnModuleInit {
  readonly contextType = GiftContextType.PRIVATE_CHAT;
  /** A DIRECT conversation has exactly two participants. */
  readonly maxReceivers = 1;

  constructor(
    @Inject(CHAT_SERVICE) private readonly chat: IChatService,
    @Inject(PRIVACY_SERVICE) private readonly privacy: IPrivacyService,
    private readonly registry: GiftContextRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async validate(req: GiftContextRequest): Promise<void> {
    if (req.receiverIds.length > this.maxReceivers) {
      throw new BusinessException(
        ERROR_CODES.GIFT_TOO_MANY_RECEIVERS,
        'Private chat gifts support a single recipient.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const receiverId = req.receiverIds[0];

    // If contextId is the receiverId (direct profile gift), validate block status directly
    if (req.contextId === receiverId) {
      if (
        receiverId !== req.senderId &&
        (await this.privacy.isBlockedEitherWay(req.senderId, receiverId))
      ) {
        throw new BusinessException(
          ERROR_CODES.GIFT_RECEIVER_INVALID,
          'You cannot send a gift to this user.',
          HttpStatus.FORBIDDEN,
        );
      }
      return;
    }

    // Otherwise, validate conversation
    const conversation = await this.chat.getConversation(req.senderId, req.contextId);

    // A request the peer has not accepted is not yet a channel they agreed to,
    // and a gift would be a way to reach them anyway.
    if (conversation.isRequest || conversation.isPendingOutbound) {
      throw new BusinessException(
        ERROR_CODES.GIFT_CONTEXT_INVALID,
        'This chat request has not been accepted yet.',
        HttpStatus.CONFLICT,
      );
    }

    const receiverInConversation =
      receiverId === req.senderId || receiverId === conversation.peer.userId;
    if (!receiverInConversation) {
      throw new BusinessException(
        ERROR_CODES.GIFT_RECEIVER_INVALID,
        'The recipient is not in this conversation.',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (
      receiverId !== req.senderId &&
      (await this.privacy.isBlockedEitherWay(req.senderId, receiverId))
    ) {
      throw new BusinessException(
        ERROR_CODES.GIFT_RECEIVER_INVALID,
        'You cannot send a gift to this user.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * Never consulted by `GiftService` today — the live settlement is hard-coded
   * in `gift.service.ts` ("Universal Soulzaa Gift Settlement Workflow"). Kept to
   * satisfy the interface, and deliberately 0 so that if the field is ever wired
   * up this context does not silently start minting earnings.
   */
}
