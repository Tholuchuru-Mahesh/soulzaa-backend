import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { IGiftContextHandler } from '../interfaces/gift-context-handler.interface';

/**
 * Resolves the handler that owns a gift context (VR-10). Each context's module
 * registers its handler on init — audio-rooms registers AUDIO_ROOM, video-rooms
 * registers VIDEO_ROOM — which is what keeps GiftService free of room-type
 * dependencies and free of a switch that would grow with every new surface.
 *
 * Adding LIVE_STREAM or PRIVATE_CHAT later is a new handler plus a `register`
 * call, with no change to this class or to GiftService.
 */
@Injectable()
export class GiftContextRegistry {
  private readonly logger = new Logger(GiftContextRegistry.name);
  private readonly handlers = new Map<GiftContextType, IGiftContextHandler>();

  /**
   * Register the handler for a context. Double registration throws rather than
   * overwriting: two handlers for one context means a wiring mistake, and
   * silently keeping the last one would make gift economics depend on module
   * init order.
   */
  register(handler: IGiftContextHandler): void {
    if (this.handlers.has(handler.contextType)) {
      throw new Error(`Gift context handler already registered for ${handler.contextType}`);
    }
    this.handlers.set(handler.contextType, handler);
    this.logger.log(`registered gift context handler: ${handler.contextType}`);
  }

  has(contextType: GiftContextType): boolean {
    return this.handlers.has(contextType);
  }

  /** The handler for a context; throws GIFT_CONTEXT_INVALID when unsupported. */
  for(contextType: GiftContextType): IGiftContextHandler {
    const handler = this.handlers.get(contextType);
    if (!handler) {
      throw new BusinessException(
        ERROR_CODES.GIFT_CONTEXT_INVALID,
        'Gifting is not supported in this context.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return handler;
  }
}
