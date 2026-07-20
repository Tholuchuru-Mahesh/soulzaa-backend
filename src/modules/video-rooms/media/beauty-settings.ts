// media/beauty-settings.ts

/** Per-user beauty-filter settings. Ephemeral (live preference) — Redis stage only, no DB column. */
export interface BeautySettings {
  enabled: boolean;
  level: number; // overall intensity 0..100
  smoothSkin: number; // 0..100
  brightness: number; // 0..100
  sharpen: number; // 0..100
  faceEnhance: number; // 0..100
}

export const DEFAULT_BEAUTY: BeautySettings = {
  enabled: false,
  level: 0,
  smoothSkin: 0,
  brightness: 0,
  sharpen: 0,
  faceEnhance: 0,
};

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Validate + clamp a (partial) beauty update onto a base. Every numeric field is
 * bounded to 0..100; unspecified fields keep the base value. Returns a fresh object.
 */
export function clampBeauty(
  input: Partial<BeautySettings> | undefined,
  base: BeautySettings = DEFAULT_BEAUTY,
): BeautySettings {
  if (!input) return { ...base };
  return {
    enabled: input.enabled ?? base.enabled,
    level: input.level === undefined ? base.level : clamp(input.level),
    smoothSkin: input.smoothSkin === undefined ? base.smoothSkin : clamp(input.smoothSkin),
    brightness: input.brightness === undefined ? base.brightness : clamp(input.brightness),
    sharpen: input.sharpen === undefined ? base.sharpen : clamp(input.sharpen),
    faceEnhance: input.faceEnhance === undefined ? base.faceEnhance : clamp(input.faceEnhance),
  };
}
