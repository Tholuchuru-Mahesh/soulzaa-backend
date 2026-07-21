import { Injectable } from '@nestjs/common';
import { BlockedWordAction, BlockedWordSeverity, ChatBlockedWord, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Persistence for the platform-wide `chat_blocked_words` dictionary. The table
 * is global — it has no room or room-type scoping — which is why the engine
 * lives in infra rather than being owned by one room domain.
 */
@Injectable()
export class BlockedWordRepository {
  constructor(private readonly prisma: PrismaService) {}

  listEnabledWords(): Promise<ChatBlockedWord[]> {
    return this.prisma.chatBlockedWord.findMany({ where: { enabled: true } });
  }

  listWords(
    skip: number,
    take: number,
    filter: { language?: string; enabled?: boolean },
  ): Promise<[ChatBlockedWord[], number]> {
    const where: Prisma.ChatBlockedWordWhereInput = {
      ...(filter.language ? { language: filter.language } : {}),
      ...(filter.enabled !== undefined ? { enabled: filter.enabled } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.chatBlockedWord.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.chatBlockedWord.count({ where }),
    ]);
  }

  getWord(id: string): Promise<ChatBlockedWord | null> {
    return this.prisma.chatBlockedWord.findUnique({ where: { id } });
  }

  findWord(pattern: string, language: string): Promise<ChatBlockedWord | null> {
    return this.prisma.chatBlockedWord.findFirst({ where: { pattern, language } });
  }

  createWord(
    input: {
      pattern: string;
      isRegex: boolean;
      language: string;
      severity: BlockedWordSeverity;
      action: BlockedWordAction;
      enabled: boolean;
      notes: string | null;
    },
    actorId: string,
  ): Promise<ChatBlockedWord> {
    return this.prisma.chatBlockedWord.create({
      data: { ...input, createdBy: actorId, updatedBy: actorId },
    });
  }

  updateWord(
    id: string,
    data: Prisma.ChatBlockedWordUpdateInput,
    actorId: string,
  ): Promise<ChatBlockedWord> {
    return this.prisma.chatBlockedWord.update({
      where: { id },
      data: { ...data, updatedBy: actorId },
    });
  }

  async deleteWord(id: string): Promise<void> {
    await this.prisma.chatBlockedWord.delete({ where: { id } });
  }

  /** Idempotent seed helper: create a default word only if the pattern is new. */
  async upsertSeedWord(input: {
    pattern: string;
    isRegex: boolean;
    language: string;
    severity: BlockedWordSeverity;
    action: BlockedWordAction;
  }): Promise<boolean> {
    const existing = await this.prisma.chatBlockedWord.findFirst({
      where: { pattern: input.pattern, language: input.language },
      select: { id: true },
    });
    if (existing) return false;
    await this.prisma.chatBlockedWord.create({
      data: { ...input, enabled: true, notes: 'seed' },
    });
    return true;
  }
}
