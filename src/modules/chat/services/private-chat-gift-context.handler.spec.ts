import { GiftContextType } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { PrivateChatGiftContextHandler } from './private-chat-gift-context.handler';

const CONVERSATION_ID = 'conv-1';
const SENDER = 'sender-1';
const RECEIVER = 'receiver-1';

const REQ = {
  contextType: GiftContextType.PRIVATE_CHAT,
  contextId: CONVERSATION_ID,
  senderId: SENDER,
  receiverIds: [RECEIVER],
  gift: { id: 'gift-1', name: 'Rose', coinValue: 100 },
  quantity: 1,
};

const conversationView = (over: Record<string, unknown> = {}) => ({
  id: CONVERSATION_ID,
  peer: { userId: RECEIVER },
  isRequest: false,
  isPendingOutbound: false,
  ...over,
});

describe('PrivateChatGiftContextHandler', () => {
  let chat: { getConversation: jest.Mock };
  let privacy: { isBlockedEitherWay: jest.Mock };
  let registry: { register: jest.Mock };
  let handler: PrivateChatGiftContextHandler;

  beforeEach(() => {
    chat = { getConversation: jest.fn().mockResolvedValue(conversationView()) };
    privacy = { isBlockedEitherWay: jest.fn().mockResolvedValue(false) };
    registry = { register: jest.fn() };
    handler = new PrivateChatGiftContextHandler(chat as never, privacy as never, registry as never);
  });

  it('registers itself on module init', () => {
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('declares PRIVATE_CHAT with maxReceivers = 1', () => {
    expect(handler.contextType).toBe(GiftContextType.PRIVATE_CHAT);
    expect(handler.maxReceivers).toBe(1);
  });

  it('accepts a gift to the other participant of the conversation', async () => {
    await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    expect(chat.getConversation).toHaveBeenCalledWith(SENDER, CONVERSATION_ID);
  });

  // Self-gifting is a supported product flow across every gift context; the
  // sender is a participant of their own conversation, so it must pass here too.
  it('allows a self-gift, matching every other gift context', async () => {
    await expect(
      handler.validate({ ...REQ, receiverIds: [SENDER] } as never),
    ).resolves.toBeUndefined();
  });

  it('rejects more than one receiver', async () => {
    await expect(
      handler.validate({ ...REQ, receiverIds: [RECEIVER, 'other'] } as never),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_TOO_MANY_RECEIVERS });
  });

  // The whole point of the handler: without it the registry's permissive default
  // would let anyone gift into any conversation id they can guess.
  it('rejects when the sender is not a participant', async () => {
    chat.getConversation.mockRejectedValue(new Error('not a participant'));
    await expect(handler.validate(REQ as never)).rejects.toThrow();
  });

  it('rejects a receiver who is not in the conversation', async () => {
    await expect(
      handler.validate({ ...REQ, receiverIds: ['stranger'] } as never),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID });
  });

  it('rejects when either side has blocked the other', async () => {
    privacy.isBlockedEitherWay.mockResolvedValue(true);
    await expect(handler.validate(REQ as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
    });
  });

  // Gifting into a request the peer has not accepted is a way to reach someone
  // who has not agreed to hear from you.
  it('rejects while the conversation is still an unaccepted request', async () => {
    chat.getConversation.mockResolvedValue(conversationView({ isPendingOutbound: true }));
    await expect(handler.validate(REQ as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_CONTEXT_INVALID,
    });
  });

  it('allows direct profile gift when contextId is receiverId without checking conversation', async () => {
    await expect(
      handler.validate({ ...REQ, contextId: RECEIVER } as never),
    ).resolves.toBeUndefined();
    expect(chat.getConversation).not.toHaveBeenCalled();
  });
});
