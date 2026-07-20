import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SubscribeStreamDto, BeautySettingsDto, CameraSwitchDto } from './media.dto';

describe('media DTOs', () => {
  it('SubscribeStreamDto requires a UUID target', () => {
    expect(
      validateSync(plainToInstance(SubscribeStreamDto, { targetUserId: 'not-a-uuid' })).length,
    ).toBeGreaterThan(0);
    expect(
      validateSync(
        plainToInstance(SubscribeStreamDto, {
          targetUserId: '11111111-1111-4111-8111-111111111111',
        }),
      ),
    ).toHaveLength(0);
  });

  it('BeautySettingsDto bounds levels 0..100', () => {
    expect(
      validateSync(plainToInstance(BeautySettingsDto, { enabled: true, level: 250 })).length,
    ).toBeGreaterThan(0);
  });

  it('CameraSwitchDto requires a valid facing', () => {
    expect(
      validateSync(plainToInstance(CameraSwitchDto, { facing: 'SIDE' })).length,
    ).toBeGreaterThan(0);
    expect(validateSync(plainToInstance(CameraSwitchDto, { facing: 'FRONT' }))).toHaveLength(0);
  });
});
