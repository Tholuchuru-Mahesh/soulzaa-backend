import type { BackpackItemSource, Cosmetic, CosmeticType } from '@prisma/client';

/**
 * Public contract for the cosmetics module — the ONLY surface other modules
 * (EXP/levels, VIP, treasure, events) may depend on, alongside the EVENT_BUS.
 * The catalog is the definition of every frame/badge/entrance-effect; awarding a
 * cosmetic deposits a per-user instance into the backpack via `grantToUser`
 * (idempotent), so callers never touch the backpack directly.
 */
export const COSMETICS_SERVICE = Symbol('COSMETICS_SERVICE');

/** Result of granting a cosmetic to a user. */
export interface CosmeticGrantResult {
  cosmeticId: string;
  backpackItemId: string;
  duplicate: boolean;
}

export interface ICosmeticsService {
  /** A catalog cosmetic by id, or null. */
  getCosmetic(cosmeticId: string): Promise<Cosmetic | null>;

  /** Enabled catalog cosmetics, optionally filtered by type. */
  listActive(type?: CosmeticType): Promise<Cosmetic[]>;

  /**
   * Get-or-create a catalog cosmetic by (type, name) and return its id. Used by
   * the EXP/VIP config seeders to reference cosmetics order-independently.
   */
  ensureCosmetic(input: {
    type: CosmeticType;
    name: string;
    rarity: import('@prisma/client').CosmeticRarity;
    mediaUrl?: string;
    transferable?: boolean;
  }): Promise<string>;

  /**
   * Deposit a cosmetic into a user's backpack (idempotent on `grantKey`).
   * Returns null if the cosmetic is missing or disabled.
   */
  grantToUser(input: {
    userId: string;
    cosmeticId: string;
    source: BackpackItemSource;
    grantKey: string;
  }): Promise<CosmeticGrantResult | null>;
}
