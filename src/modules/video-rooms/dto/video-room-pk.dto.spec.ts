import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePKInvitationDto, PausePKDto, StartPKDto } from './video-room-pk.dto';

const build = (raw: Record<string, unknown>) =>
  validate(plainToInstance(CreatePKInvitationDto, raw));

const buildStart = (raw: Record<string, unknown>) => validate(plainToInstance(StartPKDto, raw));

const buildPause = (raw: Record<string, unknown>) => validate(plainToInstance(PausePKDto, raw));

describe('CreatePKInvitationDto', () => {
  const valid = {
    mode: 'ONE_VS_ONE',
    durationSeconds: 300,
    red: ['11111111-1111-4111-8111-111111111111'],
    blue: ['22222222-2222-4222-9222-222222222222'],
  };

  it('accepts a well-formed 1v1 invitation', async () => {
    expect(await build(valid)).toHaveLength(0);
  });

  it('rejects a non-uuid participant', async () => {
    expect((await build({ ...valid, red: ['nope'] })).length).toBeGreaterThan(0);
  });

  it('rejects an unknown mode', async () => {
    expect((await build({ ...valid, mode: 'BATTLE_ROYALE' })).length).toBeGreaterThan(0);
  });

  it('rejects an empty side', async () => {
    expect((await build({ ...valid, blue: [] })).length).toBeGreaterThan(0);
  });

  // Cross-side and cardinality rules are business rules, NOT DTO rules — they
  // live in the validation service (Task 12) where the room context is known.
  it('accepts a payload the DTO cannot judge (overlap) — service rejects it later', async () => {
    const overlap = { ...valid, blue: valid.red };
    expect(await build(overlap)).toHaveLength(0);
  });

  it('rejects durationSeconds below the 60s minimum', async () => {
    expect((await build({ ...valid, durationSeconds: 59 })).length).toBeGreaterThan(0);
  });

  it('rejects durationSeconds above the 1800s maximum', async () => {
    expect((await build({ ...valid, durationSeconds: 1801 })).length).toBeGreaterThan(0);
  });

  // durationSeconds is optional: VideoRoomPkService.invite falls back to the
  // configured defaultDurationSeconds when it is absent from the payload.
  it('accepts a payload without durationSeconds', async () => {
    const { durationSeconds: _omit, ...withoutDuration } = valid;
    expect(await build(withoutDuration)).toHaveLength(0);
  });
});

describe('StartPKDto', () => {
  it('rejects countdownSeconds below the 3s minimum', async () => {
    expect((await buildStart({ countdownSeconds: 2 })).length).toBeGreaterThan(0);
  });

  it('rejects countdownSeconds above the 60s maximum', async () => {
    expect((await buildStart({ countdownSeconds: 61 })).length).toBeGreaterThan(0);
  });

  it('accepts an absent countdownSeconds', async () => {
    expect(await buildStart({})).toHaveLength(0);
  });
});

describe('PausePKDto', () => {
  // ResumePKDto and EndPKDto declare the identical @IsString/@MaxLength(200)
  // pair on `reason`, so this single pair of boundary tests covers all three.
  it('rejects a reason over the 200-char maximum', async () => {
    expect((await buildPause({ reason: 'a'.repeat(201) })).length).toBeGreaterThan(0);
  });

  it('accepts a reason at the 200-char maximum', async () => {
    expect(await buildPause({ reason: 'a'.repeat(200) })).toHaveLength(0);
  });
});
