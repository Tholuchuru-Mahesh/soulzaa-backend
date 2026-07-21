import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  AckSeatInvitationDto,
  CancelSeatInvitationDto,
  UpdateSeatRequestDto,
} from './seat-queue.dto';

const errorsFor = <T extends object>(cls: new () => T, payload: object) =>
  validateSync(plainToInstance(cls, payload) as object);

describe('UpdateSeatRequestDto', () => {
  it('accepts a valid seat index', () => {
    expect(errorsFor(UpdateSeatRequestDto, { seatIndex: 3 })).toHaveLength(0);
  });

  it('accepts null to clear the seat preference', () => {
    expect(errorsFor(UpdateSeatRequestDto, { seatIndex: null })).toHaveLength(0);
  });

  it('rejects the owner seat', () => {
    expect(errorsFor(UpdateSeatRequestDto, { seatIndex: 0 }).length).toBeGreaterThan(0);
  });

  it('rejects a seat index beyond the platform maximum', () => {
    expect(errorsFor(UpdateSeatRequestDto, { seatIndex: 999 }).length).toBeGreaterThan(0);
  });

  it('rejects a non-integer seat index', () => {
    expect(errorsFor(UpdateSeatRequestDto, { seatIndex: 2.5 }).length).toBeGreaterThan(0);
  });
});

describe('invitation id DTOs', () => {
  it.each([AckSeatInvitationDto, CancelSeatInvitationDto])('%p accepts a uuid', (cls) => {
    expect(
      errorsFor(cls as any, { invitationId: '3f1e4d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f' }),
    ).toHaveLength(0);
  });

  it.each([AckSeatInvitationDto, CancelSeatInvitationDto])('%p rejects a non-uuid', (cls) => {
    expect(errorsFor(cls as any, { invitationId: 'nope' }).length).toBeGreaterThan(0);
  });

  it.each([AckSeatInvitationDto, CancelSeatInvitationDto])('%p requires the id', (cls) => {
    expect(errorsFor(cls as any, {}).length).toBeGreaterThan(0);
  });
});
