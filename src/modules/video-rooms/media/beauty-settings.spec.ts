// beauty-settings.spec.ts
import { DEFAULT_BEAUTY, clampBeauty } from './beauty-settings';

describe('beauty-settings', () => {
  it('DEFAULT_BEAUTY is disabled with zeroed levels', () => {
    expect(DEFAULT_BEAUTY.enabled).toBe(false);
    expect(DEFAULT_BEAUTY.level).toBe(0);
  });
  it('clamps every numeric field to 0..100', () => {
    const r = clampBeauty({
      enabled: true,
      level: 150,
      smoothSkin: -5,
      brightness: 42,
      sharpen: 999,
      faceEnhance: 0,
    });
    expect(r.enabled).toBe(true);
    expect(r.level).toBe(100);
    expect(r.smoothSkin).toBe(0);
    expect(r.brightness).toBe(42);
    expect(r.sharpen).toBe(100);
  });
  it('merges onto a base for partial updates', () => {
    const base = clampBeauty({
      enabled: true,
      level: 30,
      smoothSkin: 30,
      brightness: 30,
      sharpen: 30,
      faceEnhance: 30,
    });
    const r = clampBeauty({ level: 60 }, base);
    expect(r.level).toBe(60);
    expect(r.smoothSkin).toBe(30); // preserved from base
  });
  it('undefined input returns the base (or default) unchanged', () => {
    expect(clampBeauty(undefined)).toEqual(DEFAULT_BEAUTY);
  });
});
