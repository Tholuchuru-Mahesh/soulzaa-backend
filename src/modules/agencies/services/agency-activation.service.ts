import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { RoleService } from 'src/modules/authorization/services/role.service';

/**
 * Default activation fee, in minor units. ₹500.00.
 *
 * Overridable with `AGENCY_ACTIVATION_FEE_MINOR`, so changing the price is a
 * config change rather than a deploy. Held in minor units because a rupee
 * amount as a float is a rounding bug waiting to happen.
 */
const DEFAULT_FEE_MINOR = 50000;
const RAZORPAY_API = 'https://api.razorpay.com/v1';

/**
 * The one-time fee that turns an approved Agency into an Agency + Coin Seller.
 *
 * Approval and activation are deliberately separate: an approved agency can
 * run its community immediately, and only paying adds the coin modules. The
 * gate is the `COIN_SELLER` role — the same role every coin route already
 * checks — so nothing else in the system needs to know this fee exists.
 *
 * The role is granted through `RoleService`, never by writing `user_roles`
 * directly: that path invalidates the cached permission set, and without it
 * the agency would keep getting 403s from Redis after paying.
 */
@Injectable()
export class AgencyActivationService {
  private readonly logger = new Logger(AgencyActivationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly roles: RoleService,
    private readonly roleResolver: RoleResolver,
  ) {}

  private feeMinor(): number {
    const raw = Number(process.env.AGENCY_ACTIVATION_FEE_MINOR);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_FEE_MINOR;
  }

  /**
   * What the activation screen renders.
   *
   * `activated` is resolved from the role rather than only from this table: an
   * agency granted COIN_SELLER by an admin, without paying, is genuinely
   * activated and must not be shown a bill.
   */
  async getStatus(agencyId: string) {
    const [row, hasRole] = await Promise.all([
      this.prisma.agencyActivation.findUnique({ where: { agencyId } }),
      this.roleResolver.hasRole(agencyId, 'COIN_SELLER'),
    ]);

    const amountMinor = row?.amountMinor ?? this.feeMinor();

    return {
      activated: hasRole || row?.status === 'ACTIVATED',
      status: row?.status ?? 'PENDING',
      amountMinor,
      // Major units for display only — the charge is always made in minor.
      amount: amountMinor / 100,
      currency: row?.currency ?? 'INR',
      paidAt: row?.paidAt ?? null,
      // Present while a payment is open, so the screen can offer "reopen"
      // rather than creating a second payable page.
      paymentUrl: row?.status === 'PENDING' ? (row?.paymentLinkUrl ?? null) : null,
    };
  }

  /**
   * Opens a hosted Razorpay page for the fee.
   *
   * Returns the existing link when one is already open — a second page for the
   * same one-time fee is a double charge waiting to happen.
   */
  async createPaymentLink(agencyId: string, idempotencyKey: string) {
    const status = await this.getStatus(agencyId);
    if (status.activated) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Coin Seller is already active on this account',
      );
    }

    const existing = await this.prisma.agencyActivation.findUnique({ where: { agencyId } });
    if (existing?.paymentLinkUrl && existing.status === 'PENDING') {
      return {
        activationId: existing.id,
        paymentUrl: existing.paymentLinkUrl,
        amountMinor: existing.amountMinor,
        amount: existing.amountMinor / 100,
        currency: existing.currency,
      };
    }

    const payments = this.config.get('payments', { infer: true });
    const keyId = payments?.razorpayKeyId?.trim();
    const keySecret = payments?.razorpayKeySecret?.trim();
    if (!keyId || !keySecret) {
      // Fails closed: without credentials there is no way to take money, and
      // pretending otherwise would leave the agency waiting on a page that
      // never loads.
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Payments are not configured. Please contact support.',
      );
    }

    const amountMinor = existing?.amountMinor ?? this.feeMinor();
    const currency = existing?.currency ?? 'INR';

    const row =
      existing ??
      (await this.prisma.agencyActivation.create({
        data: { agencyId, amountMinor, currency, idempotencyKey, status: 'PENDING' },
      }));

    const response = await fetch(`${RAZORPAY_API}/payment_links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      },
      body: JSON.stringify({
        amount: amountMinor,
        currency,
        description: 'Coin Seller activation',
        accept_partial: false,
        // Both carry our own id: reference_id survives on the link, notes
        // survive on the payment, so the webhook can match whichever shape
        // Razorpay sends.
        reference_id: row.id,
        notes: { agencyActivationId: row.id, agencyId },
        reminder_enable: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`Razorpay activation link failed (${response.status}): ${body}`);
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Could not start the payment. Please try again.',
      );
    }

    const link = (await response.json()) as { id: string; short_url: string };

    await this.prisma.agencyActivation.update({
      where: { id: row.id },
      data: {
        paymentProvider: 'RAZORPAY',
        paymentLinkId: link.id,
        paymentLinkUrl: link.short_url,
      },
    });

    return {
      activationId: row.id,
      paymentUrl: link.short_url,
      amountMinor,
      amount: amountMinor / 100,
      currency,
    };
  }

  /**
   * Marks the fee paid and grants COIN_SELLER.
   *
   * Idempotent: a replayed webhook returns the already-activated row rather
   * than granting twice. The role grant is what actually unlocks the coin
   * modules — the row is only the record of why.
   */
  async activate(activationId: string, providerTxnRef: string, paidMinor?: number) {
    const row = await this.prisma.agencyActivation.findUnique({ where: { id: activationId } });
    if (!row) {
      throw new BusinessException(ERROR_CODES.NOT_FOUND, 'Activation not found');
    }
    if (row.status === 'ACTIVATED') {
      return row;
    }

    // What was paid has to cover the fee. A signature proves Razorpay sent the
    // event, not that the amount matches.
    if (paidMinor !== undefined && paidMinor < row.amountMinor) {
      this.logger.error(
        `Activation ${activationId}: paid ${paidMinor} against a fee of ${row.amountMinor}`,
      );
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Paid amount does not cover the activation fee',
      );
    }

    const updated = await this.prisma.agencyActivation.update({
      where: { id: activationId },
      data: { status: 'ACTIVATED', paidAt: new Date(), providerTxnRef },
    });

    await this.grantCoinSeller(row.agencyId);
    return updated;
  }

  /**
   * Grants COIN_SELLER through RoleService so the cached permission set is
   * invalidated. Writing `user_roles` directly would leave the agency holding
   * the role in Postgres and still being refused by the cache.
   */
  private async grantCoinSeller(agencyId: string): Promise<void> {
    const role = await this.prisma.role.findUnique({ where: { name: 'COIN_SELLER' } });
    if (!role) {
      // The role is seeded on every bootstrap, so this means the seed failed —
      // worth shouting about, because the agency has paid and has nothing.
      this.logger.error('COIN_SELLER role is missing; cannot activate a paid agency');
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Coin Seller role is not configured. Please contact support.',
      );
    }

    await this.roles.assignRoleToUser({ userId: agencyId, roleId: role.id });
  }

  /** Resolves a Razorpay webhook payload to an activation id, if it is one. */
  resolveActivationId(event: {
    payload?: {
      payment?: { entity?: { notes?: Record<string, string> } };
      payment_link?: { entity?: { reference_id?: string } };
    };
  }): string | null {
    return (
      event.payload?.payment?.entity?.notes?.agencyActivationId ??
      event.payload?.payment_link?.entity?.reference_id ??
      null
    );
  }
}
