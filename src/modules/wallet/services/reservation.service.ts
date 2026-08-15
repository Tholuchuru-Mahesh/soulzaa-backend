import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ReservationStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  ConsumeReservationDto,
  ReleaseReservationDto,
  ReserveCoinsDto,
} from '../dto/reservation.dto';
import { WalletAuditService } from './wallet-audit.service';
import { WalletValidationService } from './wallet-validation.service';
import { WalletService } from './wallet.service';

@Injectable()
export class ReservationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly validationService: WalletValidationService,
    private readonly auditService: WalletAuditService,
  ) {}

  /**
   * Places a coin reservation hold on a user's wallet
   */
  async reserveCoins(dto: ReserveCoinsDto, actorId?: string) {
    await this.validationService.validateEconomyStatus();

    const wallet = await this.walletService.getOrCreateWallet(dto.userId);
    this.validationService.validateWalletActive(wallet);

    const amountBig = BigInt(dto.amount);
    this.validationService.validatePositiveAmount(amountBig);
    this.validationService.validateSufficientBalance(wallet, amountBig);

    const expiresAt = dto.expiresInSeconds
      ? new Date(Date.now() + dto.expiresInSeconds * 1000)
      : undefined;

    return this.prisma.$transaction(async (tx) => {
      // Row-level pessimistic lock + re-validation INSIDE the transaction: the
      // pre-transaction `validateSufficientBalance` above is a fast-fail check,
      // but two concurrent reserves could both pass it before either commits.
      // Re-reading under `FOR UPDATE` and re-checking closes that TOCTOU so the
      // aggregate can never be driven negative.
      await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${wallet.id}::uuid FOR UPDATE`;
      const lockedWallet = await tx.wallet.findUnique({ where: { id: wallet.id } });
      if (!lockedWallet) {
        throw new NotFoundException('Wallet not found');
      }
      this.validationService.validateWalletActive(lockedWallet);
      this.validationService.validateSufficientBalance(lockedWallet, amountBig);

      // Move balance from availableBalance to reservedBalance
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalance: { decrement: amountBig },
          reservedBalance: { increment: amountBig },
          version: { increment: 1 },
        },
      });

      const reservation = await tx.walletReservation.create({
        data: {
          walletId: wallet.id,
          currency: dto.currency ?? 'GOLD',
          amount: amountBig,
          purpose: dto.purpose,
          status: ReservationStatus.HELD,
          referenceType: dto.referenceType,
          referenceId: dto.referenceId,
          expiresAt,
        },
      });

      await this.auditService.logAudit(
        wallet.id,
        'RESERVATION_CREATED',
        { reservationId: reservation.id, amount: amountBig.toString() },
        actorId,
      );

      return {
        ...reservation,
        amount: reservation.amount.toString(),
        walletAvailableBalance: updatedWallet.availableBalance.toString(),
        walletReservedBalance: updatedWallet.reservedBalance.toString(),
      };
    });
  }

  /**
   * Releases an active reservation hold back to available balance
   */
  async releaseReservation(reservationId: string, dto?: ReleaseReservationDto, actorId?: string) {
    const reservation = await this.prisma.walletReservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) {
      throw new NotFoundException(`Reservation '${reservationId}' not found`);
    }

    if (reservation.status !== ReservationStatus.HELD) {
      throw new BadRequestException(
        `Reservation '${reservationId}' is not active (Status: ${reservation.status})`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedWallet = await tx.wallet.update({
        where: { id: reservation.walletId },
        data: {
          availableBalance: { increment: reservation.amount },
          reservedBalance: { decrement: reservation.amount },
          version: { increment: 1 },
        },
      });

      const updatedReservation = await tx.walletReservation.update({
        where: { id: reservationId },
        data: { status: ReservationStatus.RELEASED },
      });

      await this.auditService.logAudit(
        reservation.walletId,
        'RESERVATION_RELEASED',
        { reservationId, reason: dto?.reason },
        actorId,
      );

      return {
        ...updatedReservation,
        amount: updatedReservation.amount.toString(),
        walletAvailableBalance: updatedWallet.availableBalance.toString(),
        walletReservedBalance: updatedWallet.reservedBalance.toString(),
      };
    });
  }

  /**
   * Consumes a reservation hold (decrements reserved balance and logs consumption)
   */
  async consumeReservation(reservationId: string, dto: ConsumeReservationDto, actorId?: string) {
    const reservation = await this.prisma.walletReservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) {
      throw new NotFoundException(`Reservation '${reservationId}' not found`);
    }

    if (reservation.status !== ReservationStatus.HELD) {
      throw new BadRequestException(
        `Reservation '${reservationId}' is not active (Status: ${reservation.status})`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedWallet = await tx.wallet.update({
        where: { id: reservation.walletId },
        data: {
          reservedBalance: { decrement: reservation.amount },
          totalSpent: { increment: reservation.amount },
          version: { increment: 1 },
        },
      });

      const updatedReservation = await tx.walletReservation.update({
        where: { id: reservationId },
        data: { status: ReservationStatus.CONSUMED },
      });

      await this.auditService.logAudit(
        reservation.walletId,
        'RESERVATION_CONSUMED',
        { reservationId, reason: dto.reason },
        actorId,
      );

      return {
        ...updatedReservation,
        amount: updatedReservation.amount.toString(),
        walletReservedBalance: updatedWallet.reservedBalance.toString(),
      };
    });
  }
}
