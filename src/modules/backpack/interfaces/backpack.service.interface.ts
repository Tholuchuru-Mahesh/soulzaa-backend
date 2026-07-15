import type { BackpackItemSource, BackpackItemType } from '@prisma/client';

/**
 * Public contract for the backpack module — the ONLY surface other modules
 * (treasure boxes, rocket events, VIP, attendance, events) may depend on,
 * alongside the EVENT_BUS. Internals stay private. The economy features grant
 * earned non-coin rewards here; equipping/transfer is user-driven via the REST
 * controller. Grants are idempotent on `grantKey`.
 */
export const BACKPACK_SERVICE = Symbol('BACKPACK_SERVICE');

/** A reward to deposit into a user's backpack. */
export interface GrantItemInput {
  userId: string;
  type: BackpackItemType;
  name: string;
  source: BackpackItemSource;
  /** Optional id into the source catalog (frame/theme id, etc.). */
  refId?: string;
  quantity?: number;
  transferable?: boolean;
  /** Globally-unique key; a replay returns the original item, no re-grant. */
  grantKey: string;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
}

/** Result of a grant. `duplicate` true ⇒ an idempotent replay. */
export interface GrantItemResult {
  itemId: string;
  duplicate: boolean;
}

/** The equipped cosmetic of a type (for entrance-effect playback etc.). */
export interface EquippedItemView {
  itemId: string;
  cosmeticId: string | null;
  name: string;
}

export interface IBackpackService {
  /** Deposit a reward item (idempotent on `grantKey`). */
  grant(input: GrantItemInput, tx?: any): Promise<GrantItemResult>;

  /** The user's currently-equipped item of a type, or null. */
  getEquipped(userId: string, type: BackpackItemType): Promise<EquippedItemView | null>;

  /** True when the user owns an (unexpired) instance of the given cosmetic. */
  ownsCosmetic(userId: string, cosmeticId: string): Promise<boolean>;
}
