/**
 * Public contract for reading platform settings.
 *
 * Domain modules depend on this token rather than importing
 * ConfigurationEngineService directly, which keeps them inside the module
 * boundary rule (a module may only reach another module through its
 * `interfaces/`). The PRD requires every economy value to be operator-editable,
 * so anything tunable belongs behind this port instead of a compiled-in literal.
 */
export interface IPlatformConfiguration {
  /**
   * Resolves a setting by key. Returns `defaultValue` when the key is absent,
   * or null when no default is supplied.
   */
  get<T = unknown>(key: string, defaultValue?: T): Promise<T>;
}

export const PLATFORM_CONFIG = Symbol('PLATFORM_CONFIG');
