import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendChatMessageDto } from './send-chat-message.dto';
import { SearchChatMessagesDto } from './search-chat-messages.dto';

describe('chat DTO validation', () => {
  it('accepts a plain text message', async () => {
    const dto = plainToInstance(SendChatMessageDto, { content: 'hello' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects empty content', async () => {
    const dto = plainToInstance(SendChatMessageDto, { content: '' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects an unknown message type', async () => {
    const dto = plainToInstance(SendChatMessageDto, { content: 'x', type: 'TELEPATHY' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects a non-uuid replyToId', async () => {
    const dto = plainToInstance(SendChatMessageDto, { content: 'x', replyToId: 'nope' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('coerces search dates from ISO strings', async () => {
    const dto = plainToInstance(SearchChatMessagesDto, { q: 'hi', from: '2026-07-01' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.from).toBeInstanceOf(Date);
  });

  it('coerces pinnedOnly/announcementsOnly from query-string "true"', async () => {
    const dto = plainToInstance(SearchChatMessagesDto, {
      pinnedOnly: 'true',
      announcementsOnly: 'true',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.pinnedOnly).toBe(true);
    expect(dto.announcementsOnly).toBe(true);
  });

  it('leaves pinnedOnly/announcementsOnly undefined when omitted (no-op filters)', async () => {
    const dto = plainToInstance(SearchChatMessagesDto, { q: 'hi' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.pinnedOnly).toBeUndefined();
    expect(dto.announcementsOnly).toBeUndefined();
  });
});
