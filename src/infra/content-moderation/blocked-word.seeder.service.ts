import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { BlockedWordAction, BlockedWordSeverity } from '@prisma/client';
import { BlockedWordRepository } from './blocked-word.repository';

/** A default dictionary entry (literal unless `isRegex`). */
interface SeedWord {
  pattern: string;
  isRegex?: boolean;
  language?: string;
  severity: BlockedWordSeverity;
  action: BlockedWordAction;
}

/**
 * A small, conservative starter dictionary spanning the three severities and a
 * couple of languages, plus regex patterns for structured critical content
 * (crude self-harm / doxxing style signals). Operators are expected to curate
 * the real list via the admin CRUD; this only guarantees the filter is non-empty
 * on a fresh database. Mild → MASK, offensive → REJECT, critical → ESCALATE.
 */
const SEED_WORDS: SeedWord[] = [
  // ---- MILD (masked) ----
  { pattern: 'damn', severity: BlockedWordSeverity.MILD, action: BlockedWordAction.MASK },
  { pattern: 'crap', severity: BlockedWordSeverity.MILD, action: BlockedWordAction.MASK },
  { pattern: 'idiot', severity: BlockedWordSeverity.MILD, action: BlockedWordAction.MASK },
  // Hindi (romanised) mild
  {
    pattern: 'bakwaas',
    language: 'hi',
    severity: BlockedWordSeverity.MILD,
    action: BlockedWordAction.MASK,
  },

  // ---- OFFENSIVE (rejected) ----
  { pattern: 'asshole', severity: BlockedWordSeverity.OFFENSIVE, action: BlockedWordAction.REJECT },
  { pattern: 'bastard', severity: BlockedWordSeverity.OFFENSIVE, action: BlockedWordAction.REJECT },
  { pattern: 'bitch', severity: BlockedWordSeverity.OFFENSIVE, action: BlockedWordAction.REJECT },
  // Leet-speak variants via regex
  {
    pattern: 'f+[u\\*@]+c+k+',
    isRegex: true,
    severity: BlockedWordSeverity.OFFENSIVE,
    action: BlockedWordAction.REJECT,
  },

  // ---- CRITICAL (escalated) ----
  {
    pattern: 'kill yourself',
    severity: BlockedWordSeverity.CRITICAL,
    action: BlockedWordAction.ESCALATE,
  },
  { pattern: 'kys', severity: BlockedWordSeverity.CRITICAL, action: BlockedWordAction.ESCALATE },
  {
    pattern: 'child porn',
    severity: BlockedWordSeverity.CRITICAL,
    action: BlockedWordAction.ESCALATE,
  },
  {
    pattern: 'i will kill you',
    severity: BlockedWordSeverity.CRITICAL,
    action: BlockedWordAction.ESCALATE,
  },
];

/**
 * Idempotently seeds the default blocked-word dictionary on bootstrap so the
 * severity engine has content on a fresh database. Inserts only patterns that
 * are not already present (per language), so operator edits/deletions are never
 * clobbered. Never blocks startup on failure (e.g. migrations not yet applied).
 */
@Injectable()
export class ChatBlockedWordSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChatBlockedWordSeeder.name);

  constructor(private readonly words: BlockedWordRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      let created = 0;
      for (const w of SEED_WORDS) {
        const inserted = await this.words.upsertSeedWord({
          pattern: w.pattern,
          isRegex: w.isRegex ?? false,
          language: w.language ?? 'en',
          severity: w.severity,
          action: w.action,
        });
        if (inserted) created += 1;
      }
      if (created > 0) this.logger.log(`Seeded ${created} default blocked words`);
    } catch (err) {
      this.logger.warn(`Blocked-word seed skipped: ${(err as Error).message}`);
    }
  }
}
