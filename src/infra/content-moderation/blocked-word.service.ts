import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BlockedWordAction, BlockedWordSeverity, ChatBlockedWord } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { CHAT_MASK_TOKEN } from './content-moderation.constants';
import { BlockedWordRepository } from './blocked-word.repository';

/** A single dictionary entry compiled to an executable matcher. */
interface CompiledWord {
  regex: RegExp;
  severity: BlockedWordSeverity;
  action: BlockedWordAction;
}

/** The outcome of scanning a message body against the dictionary. */
export interface BlockedWordScan {
  matched: boolean;
  /** Highest-severity match found (undefined when clean). */
  severity?: BlockedWordSeverity;
  /** Action of the highest-severity match. */
  action?: BlockedWordAction;
  /** Distinct matched substrings (for the audit trail). */
  matches: string[];
  /** The input with every matched term replaced by the mask token. */
  maskedText: string;
}

const SEVERITY_RANK: Record<BlockedWordSeverity, number> = {
  [BlockedWordSeverity.MILD]: 1,
  [BlockedWordSeverity.OFFENSIVE]: 2,
  [BlockedWordSeverity.CRITICAL]: 3,
};

/**
 * The severity-based blocked-word engine (AR-4). Loads the enabled
 * `chat_blocked_words` dictionary into an in-memory compiled set on bootstrap,
 * refreshes it on a periodic timer and whenever the admin CRUD invalidates it,
 * so the chat hot path never queries the DB to filter a message. Literal
 * patterns match on Unicode word boundaries (multilingual); `isRegex` patterns
 * compile to a `RegExp`. `scan()` returns the highest-severity match plus a
 * fully masked copy of the text (used for the MILD/MASK action).
 */
@Injectable()
export class BlockedWordService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BlockedWordService.name);
  private compiled: CompiledWord[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly words: BlockedWordRepository,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    const seconds = this.reloadSeconds();
    this.timer = setInterval(() => {
      void this.reload().catch((err) =>
        this.logger.warn(`Blocked-word reload failed: ${(err as Error).message}`),
      );
    }, seconds * 1000);
    // Don't keep the event loop alive solely for the refresh timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private reloadSeconds(): number {
    const cfg = this.config.get('audioRoom') as { chat?: { blockedWordReloadSeconds?: number } };
    return cfg?.chat?.blockedWordReloadSeconds ?? 300;
  }

  /** Force an immediate reload (called after admin CRUD). */
  async invalidate(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const words = await this.words.listEnabledWords();
    this.compiled = words.map((w) => this.compile(w)).filter((c): c is CompiledWord => c !== null);
  }

  private compile(word: ChatBlockedWord): CompiledWord | null {
    try {
      const source = word.isRegex ? word.pattern : this.literalToBoundedSource(word.pattern);
      const regex = this.buildRegex(source);
      return { regex, severity: word.severity, action: word.action };
    } catch (err) {
      this.logger.warn(
        `Skipping uncompilable blocked word "${word.pattern}" (${word.id}): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Escape a literal and wrap it in Unicode-aware, letter/number boundaries. */
  private literalToBoundedSource(literal: string): string {
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`;
  }

  /** Compile global + case-insensitive; prefer Unicode mode, fall back without it. */
  private buildRegex(source: string): RegExp {
    try {
      return new RegExp(source, 'giu');
    } catch {
      return new RegExp(source, 'gi');
    }
  }

  /**
   * Scan `text` against the dictionary. Returns the highest-severity match and a
   * masked copy (every matched term → mask token). Clean text ⇒ `matched:false`.
   */
  scan(text: string): BlockedWordScan {
    if (!text) return { matched: false, matches: [], maskedText: text };

    let topSeverity: BlockedWordSeverity | undefined;
    let topAction: BlockedWordAction | undefined;
    const matches = new Set<string>();
    let maskedText = text;

    for (const word of this.compiled) {
      // matchAll clones the regex, so shared lastIndex is never an issue.
      const found = [...text.matchAll(word.regex)];
      if (found.length === 0) continue;

      for (const m of found) matches.add(m[0]);
      maskedText = maskedText.replace(word.regex, CHAT_MASK_TOKEN);

      if (topSeverity === undefined || SEVERITY_RANK[word.severity] > SEVERITY_RANK[topSeverity]) {
        topSeverity = word.severity;
        topAction = word.action;
      }
    }

    if (topSeverity === undefined) {
      return { matched: false, matches: [], maskedText: text };
    }

    return {
      matched: true,
      severity: topSeverity,
      action: topAction,
      matches: [...matches],
      maskedText,
    };
  }

  /** Number of compiled entries currently loaded (diagnostics/tests). */
  get size(): number {
    return this.compiled.length;
  }
}
