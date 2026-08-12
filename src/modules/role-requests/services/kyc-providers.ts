import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoleRequestDocumentSlot } from '@prisma/client';
import {
  KycCheckResult,
  KycProvider,
  KycProviderDocument,
  KycProviderUnavailableError,
} from '../interfaces/kyc-provider.interface';

/**
 * Vendor document-type strings → our slots.
 *
 * Both vendors classify with their own vocabulary and neither is stable across
 * API versions, so matching is done on a normalised, lowercased substring
 * rather than exact equality.
 */
function slotFromVendorType(raw: string | undefined | null): RoleRequestDocumentSlot | null {
  if (!raw) return null;
  const value = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (value.includes('aadhaar') || value.includes('aadhar') || value.includes('uid')) {
    return RoleRequestDocumentSlot.AADHAAR;
  }
  if (value.includes('pan')) return RoleRequestDocumentSlot.PAN;
  return null;
}

/**
 * The provider used when `KYC_PROVIDER=none`.
 *
 * Reports itself disabled so the verifier skips the call entirely. This is what
 * keeps the feature inert until real credentials exist: no network call, no
 * behaviour change, no risk of blocking applicants because an unconfigured
 * integration returned nonsense.
 */
@Injectable()
export class NullKycProvider implements KycProvider {
  readonly name = 'none';
  readonly enabled = false;

  check(): Promise<KycCheckResult> {
    throw new KycProviderUnavailableError('No KYC provider is configured.');
  }
}

/** Shared HTTP plumbing for the vendor adapters. */
abstract class HttpKycProvider implements KycProvider {
  abstract readonly name: string;
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly baseUrl: string | undefined,
    protected readonly apiKey: string | undefined,
    protected readonly accountId: string | undefined,
    protected readonly timeoutMs: number,
  ) {}

  get enabled(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  abstract check(document: KycProviderDocument): Promise<KycCheckResult>;

  /**
   * POST JSON with a hard timeout.
   *
   * Any transport or non-2xx outcome becomes [KycProviderUnavailableError], so
   * the caller can distinguish "the provider is down" from "the provider says
   * this is not an Aadhaar". Conflating the two would reject honest applicants
   * during a vendor outage.
   */
  protected async post<T>(
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new KycProviderUnavailableError(`${this.name} returned HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof KycProviderUnavailableError) throw err;
      throw new KycProviderUnavailableError(
        `${this.name} request failed: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Signzy document OCR + verification.
 *
 * REQUEST/RESPONSE MAPPING IS UNVERIFIED. Signzy's API is behind a commercial
 * contract with no public sandbox, so the field names below are written from
 * their published shape and have not been exercised against a live account.
 * Confirm them against your contract's docs before enabling — a wrong mapping
 * surfaces as every document coming back unclassified, which the verifier
 * treats as "not an Aadhaar" and would reject real applicants.
 */
@Injectable()
export class SignzyKycProvider extends HttpKycProvider {
  readonly name = 'signzy';

  async check(document: KycProviderDocument): Promise<KycCheckResult> {
    const payload = await this.post<{
      result?: {
        documentType?: string;
        verified?: boolean;
        confidence?: number;
        number?: string;
        name?: string;
        dob?: string;
        reason?: string;
      };
    }>(
      '/api/v2/documents/analyse',
      {
        documentType: document.slot === RoleRequestDocumentSlot.PAN ? 'pan' : 'aadhaar',
        file: {
          filename: document.filename,
          contentType: document.contentType,
          content: document.bytes.toString('base64'),
        },
      },
      { Authorization: this.apiKey ?? '' },
    );

    const result = payload.result ?? {};
    return {
      detectedSlot: slotFromVendorType(result.documentType),
      sourceVerified: result.verified === true,
      confidence: typeof result.confidence === 'number' ? result.confidence : null,
      extracted: { documentNumber: result.number, name: result.name, dateOfBirth: result.dob },
      reason: result.reason,
    };
  }
}

/**
 * IDfy synchronous document extraction.
 *
 * REQUEST/RESPONSE MAPPING IS UNVERIFIED — same caveat as Signzy above. IDfy
 * authenticates with `api-key` plus `account-id`, which is why the config
 * carries an account id the other vendor ignores.
 */
@Injectable()
export class IdfyKycProvider extends HttpKycProvider {
  readonly name = 'idfy';

  async check(document: KycProviderDocument): Promise<KycCheckResult> {
    const payload = await this.post<{
      status?: string;
      result?: {
        extraction_output?: {
          document_type?: string;
          id_number?: string;
          name?: string;
          date_of_birth?: string;
          confidence?: number;
        };
        source_output?: { status?: string };
      };
    }>(
      '/v3/tasks/sync/extract_document',
      {
        task_id: `role-request-${document.slot.toLowerCase()}`,
        group_id: 'soulzaa-role-requests',
        data: {
          document1: document.bytes.toString('base64'),
          doc_type: document.slot === RoleRequestDocumentSlot.PAN ? 'ind_pan' : 'ind_aadhaar',
        },
      },
      { 'api-key': this.apiKey ?? '', 'account-id': this.accountId ?? '' },
    );

    const extraction = payload.result?.extraction_output ?? {};
    return {
      detectedSlot: slotFromVendorType(extraction.document_type),
      sourceVerified: payload.result?.source_output?.status === 'id_found',
      confidence: typeof extraction.confidence === 'number' ? extraction.confidence : null,
      extracted: {
        documentNumber: extraction.id_number,
        name: extraction.name,
        dateOfBirth: extraction.date_of_birth,
      },
    };
  }
}

/** Shape of the `kyc` config namespace registered in configuration.ts. */
export interface KycConfig {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  accountId?: string;
  timeoutMs?: number;
}

/**
 * Chooses the adapter from `KYC_PROVIDER`. Unknown or absent selects the null
 * provider, so a typo in the environment degrades to today's behaviour rather
 * than crashing the API at boot.
 */
export function createKycProvider(config: ConfigService): KycProvider {
  const cfg = config.get<KycConfig>('kyc');

  const timeout = Number(cfg?.timeoutMs ?? 15000);
  switch (cfg?.provider) {
    case 'signzy':
      return new SignzyKycProvider(cfg.baseUrl, cfg.apiKey, cfg.accountId, timeout);
    case 'idfy':
      return new IdfyKycProvider(cfg.baseUrl, cfg.apiKey, cfg.accountId, timeout);
    default:
      return new NullKycProvider();
  }
}
