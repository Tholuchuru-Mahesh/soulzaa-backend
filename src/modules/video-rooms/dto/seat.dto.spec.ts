import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { LockSeatsDto, ReserveSeatDto, TransferSeatDto } from './seat.dto';

const errorsFor = <T extends object>(cls: new () => T, payload: object): string[] =>
  validateSync(plainToInstance(cls, payload)).flatMap((e) => Object.keys(e.constraints ?? {}));

describe('seat DTOs', () => {
  it('TransferSeatDto requires a uuid userId + non-negative toSeatIndex', () => {
    expect(errorsFor(TransferSeatDto, { userId: 'u1', toSeatIndex: 2 })).not.toHaveLength(0); // bad uuid
    expect(
      validateSync(
        plainToInstance(TransferSeatDto, {
          userId: '11111111-1111-4111-8111-111111111111',
          toSeatIndex: 2,
          force: true,
        }),
      ),
    ).toHaveLength(0);
  });

  it('LockSeatsDto rejects an empty seatIndexes array', () => {
    expect(errorsFor(LockSeatsDto, { seatIndexes: [] })).not.toHaveLength(0);
    expect(
      validateSync(plainToInstance(LockSeatsDto, { seatIndexes: [1, 2], reason: 'maintenance' })),
    ).toHaveLength(0);
  });

  it('ReserveSeatDto requires seatIndex + forUserId and bounds ttlSeconds', () => {
    expect(
      validateSync(
        plainToInstance(ReserveSeatDto, {
          seatIndex: 1,
          forUserId: '11111111-1111-4111-8111-111111111111',
        }),
      ),
    ).toHaveLength(0);
    expect(
      errorsFor(ReserveSeatDto, {
        seatIndex: 1,
        forUserId: '11111111-1111-4111-8111-111111111111',
        ttlSeconds: 1,
      }),
    ).toContain('min');
  });
});
