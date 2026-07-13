import { Global, Module } from '@nestjs/common';
import { ConversationsController } from './controllers/conversations.controller';
import { MessagesController } from './controllers/messages.controller';
import { CHAT_SERVICE } from './interfaces/chat.service.interface';
import { ChatSocketListener } from './listeners/chat-socket.listener';
import { ConversationRepository } from './repositories/conversation.repository';
import { MessageRepository } from './repositories/message.repository';
import { ChatViewMapper } from './services/chat-view.mapper';
import { ChatService } from './services/chat.service';

/**
 * Chat domain — 1:1 conversations, direct messages, receipts, reactions,
 * drafts and chat requests. Owns the conversations / conversation_participants /
 * direct_messages / message_attachments / message_reactions tables.
 *
 * Consumes PRIVACY_SERVICE (the `MESSAGE` gate + block list), RELATIONSHIP_SERVICE
 * (friends chat directly; strangers must send a request), PROFILE_SERVICE (peer
 * card hydration + search) and SocketManager (per-user `/chat` fan-out). Media
 * rides the shared presign/confirm flow in infra/storage — this module stores
 * object keys, never bytes.
 *
 * @Global so consumers resolve CHAT_SERVICE by token without importing this
 * module. The notification module bridges `chat.*` bus events into push rather
 * than calling in here.
 */
@Global()
@Module({
  controllers: [ConversationsController, MessagesController],
  providers: [
    // repositories
    ConversationRepository,
    MessageRepository,
    // services
    ChatViewMapper,
    ChatService,
    // listeners
    ChatSocketListener,
    // public token
    { provide: CHAT_SERVICE, useExisting: ChatService },
  ],
  exports: [CHAT_SERVICE],
})
export class ChatModule {}
