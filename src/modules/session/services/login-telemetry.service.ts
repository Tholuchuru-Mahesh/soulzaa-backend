import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/** Resolves a client IP to an ISO country code. Null when it cannot. */
export const GEO_IP_RESOLVER = Symbol('GEO_IP_RESOLVER');

export interface IGeoIpResolver {
  countryFor(ip: string): Promise<string | null>;
}

export interface LoginTelemetry {
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  country: string | null;
}

/**
 * Ordered longest-match-first: "Edg" must beat "Chrome" because Edge's
 * user-agent contains both, and "Chrome" must beat "Safari" for the same reason.
 */
const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg[A-Z]?\//, 'Edge'],
  [/\bOPR\/|\bOpera\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const OSES: Array<[RegExp, string]> = [
  [/\bWindows NT\b/, 'Windows'],
  [/\biPhone\b|\biPad\b|\biPod\b|\biOS\b/, 'iOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
];

/**
 * Derives browser / OS / device / country for the session audit trail (spec §2).
 *
 * Hand-rolled rather than pulling in a user-agent library: three coarse fields
 * for an operator audit log do not justify the dependency surface, and this
 * project pins/overrides transitive deps for exactly that reason. The trade-off
 * is accepted knowingly — exotic or spoofed agents degrade to null rather than
 * being identified precisely, which is fine for an audit hint and is why nothing
 * downstream may treat these values as authoritative.
 *
 * Everything degrades to null and nothing throws: telemetry is observational,
 * and a login must never fail because a header was strange.
 */
@Injectable()
export class LoginTelemetryService {
  private readonly logger = new Logger(LoginTelemetryService.name);
  private warnedNoGeo = false;

  constructor(@Optional() @Inject(GEO_IP_RESOLVER) private readonly geo?: IGeoIpResolver) {}

  async describe(input: {
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<LoginTelemetry> {
    const ua = input.userAgent ?? '';
    return {
      browser: this.match(ua, BROWSERS),
      os: this.match(ua, OSES),
      deviceType: this.deviceType(ua),
      country: await this.country(input.ip),
    };
  }

  private match(ua: string, table: Array<[RegExp, string]>): string | null {
    if (!ua) return null;
    for (const [pattern, label] of table) {
      if (pattern.test(ua)) return label;
    }
    return null;
  }

  private deviceType(ua: string): string | null {
    if (!ua) return null;
    // Order matters: an iPad reports "Mobile" in some configurations, so tablet
    // detection runs first.
    if (/\biPad\b|\bTablet\b|\bAndroid\b(?!.*\bMobile\b)/.test(ua)) return 'tablet';
    if (/\bMobi\b|\bMobile\b|\biPhone\b|\biPod\b|\bAndroid\b/.test(ua)) return 'mobile';
    if (/\bWindows NT\b|\bMacintosh\b|\bX11\b|\bCrOS\b|\bLinux\b/.test(ua)) return 'desktop';
    return null;
  }

  private async country(ip?: string | null): Promise<string | null> {
    if (!ip) return null;
    if (!this.geo) {
      if (!this.warnedNoGeo) {
        this.warnedNoGeo = true;
        // Logged once, not per login: the gap should be visible in ops without
        // drowning the log.
        this.logger.warn('No geo-IP resolver configured — login country will be null');
      }
      return null;
    }
    try {
      return await this.geo.countryFor(ip);
    } catch (err) {
      this.logger.warn(`Geo-IP lookup failed: ${(err as Error).message}`);
      return null;
    }
  }
}
