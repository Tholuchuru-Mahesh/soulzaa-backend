import { BlockedWordAction, BlockedWordSeverity, ChatBlockedWord } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { ChatRepository } from '../repositories/chat.repository';
import { BlockedWordService } from './blocked-word.service';

/** Minimal factory for a dictionary row. */
function word(
  partial: Partial<ChatBlockedWord> & Pick<ChatBlockedWord, 'pattern'>,
): ChatBlockedWord {
  return {
    id: partial.id ?? `w-${partial.pattern}`,
    pattern: partial.pattern,
    isRegex: partial.isRegex ?? false,
    language: partial.language ?? 'en',
    severity: partial.severity ?? BlockedWordSeverity.MILD,
    action: partial.action ?? BlockedWordAction.MASK,
    enabled: partial.enabled ?? true,
    notes: partial.notes ?? null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('BlockedWordService', () => {
  let repo: { listEnabledWords: jest.Mock };
  let service: BlockedWordService;

  async function load(words: ChatBlockedWord[]): Promise<void> {
    repo.listEnabledWords.mockResolvedValue(words);
    await service.invalidate();
  }

  beforeEach(() => {
    repo = { listEnabledWords: jest.fn().mockResolvedValue([]) };
    const config = { get: jest.fn().mockReturnValue({ chat: {} }) } as unknown as ConfigService;
    service = new BlockedWordService(repo as unknown as ChatRepository, config);
  });

  it('returns clean for text with no matches', async () => {
    await load([word({ pattern: 'damn' })]);
    const res = service.scan('hello world');
    expect(res.matched).toBe(false);
    expect(res.maskedText).toBe('hello world');
  });

  it('MILD masks the matched term and reports the action', async () => {
    await load([
      word({ pattern: 'damn', severity: BlockedWordSeverity.MILD, action: BlockedWordAction.MASK }),
    ]);
    const res = service.scan('oh damn that hurt');
    expect(res.matched).toBe(true);
    expect(res.action).toBe(BlockedWordAction.MASK);
    expect(res.severity).toBe(BlockedWordSeverity.MILD);
    expect(res.maskedText).toBe('oh **** that hurt');
    expect(res.matches).toContain('damn');
  });

  it('OFFENSIVE reports a reject action', async () => {
    await load([
      word({
        pattern: 'bitch',
        severity: BlockedWordSeverity.OFFENSIVE,
        action: BlockedWordAction.REJECT,
      }),
    ]);
    const res = service.scan('you bitch');
    expect(res.matched).toBe(true);
    expect(res.action).toBe(BlockedWordAction.REJECT);
    expect(res.severity).toBe(BlockedWordSeverity.OFFENSIVE);
  });

  it('CRITICAL reports an escalate action', async () => {
    await load([
      word({
        pattern: 'kill yourself',
        severity: BlockedWordSeverity.CRITICAL,
        action: BlockedWordAction.ESCALATE,
      }),
    ]);
    const res = service.scan('just kill yourself');
    expect(res.action).toBe(BlockedWordAction.ESCALATE);
    expect(res.severity).toBe(BlockedWordSeverity.CRITICAL);
  });

  it('returns the highest severity when multiple terms match', async () => {
    await load([
      word({ pattern: 'damn', severity: BlockedWordSeverity.MILD, action: BlockedWordAction.MASK }),
      word({
        pattern: 'bitch',
        severity: BlockedWordSeverity.OFFENSIVE,
        action: BlockedWordAction.REJECT,
      }),
    ]);
    const res = service.scan('damn you bitch');
    expect(res.severity).toBe(BlockedWordSeverity.OFFENSIVE);
    expect(res.action).toBe(BlockedWordAction.REJECT);
  });

  it('matches on word boundaries (no false substring hits)', async () => {
    await load([word({ pattern: 'ass' })]);
    expect(service.scan('classic passage').matched).toBe(false);
    expect(service.scan('what an ass').matched).toBe(true);
  });

  it('is case-insensitive', async () => {
    await load([word({ pattern: 'damn' })]);
    expect(service.scan('DAMN it').matched).toBe(true);
  });

  it('supports regex patterns (leet-speak)', async () => {
    await load([
      word({
        pattern: 'f+[u\\*@]+c+k+',
        isRegex: true,
        severity: BlockedWordSeverity.OFFENSIVE,
        action: BlockedWordAction.REJECT,
      }),
    ]);
    expect(service.scan('f*ck this').matched).toBe(true);
    expect(service.scan('fuuuck').matched).toBe(true);
  });

  it('matches multilingual (non-latin) literals', async () => {
    await load([
      word({ pattern: 'गाली', language: 'hi', severity: BlockedWordSeverity.OFFENSIVE }),
    ]);
    expect(service.scan('ये गाली है').matched).toBe(true);
  });

  it('skips patterns that do not compile without throwing', async () => {
    await load([word({ pattern: '(unclosed', isRegex: true }), word({ pattern: 'damn' })]);
    expect(service.size).toBe(1);
    expect(service.scan('damn').matched).toBe(true);
  });
});
