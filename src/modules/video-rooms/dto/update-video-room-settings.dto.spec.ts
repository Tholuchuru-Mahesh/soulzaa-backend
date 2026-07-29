import { getMetadataStorage } from 'class-validator';
import { WRITABLE_SETTINGS_FIELDS } from '../services/video-room-settings.service';
import { UpdateVideoRoomSettingsDto } from './update-video-room-settings.dto';

/**
 * The DTO and WRITABLE_SETTINGS_FIELDS were maintained independently and
 * drifted to 22-vs-11: eleven fields passed validation and then hard-400'd at
 * the service. Swagger advertised all 22. This pins them together so the next
 * divergence fails here instead of in a client.
 *
 * class-validator's public metadata API is used rather than Nest's
 * `swagger/apiModelPropertiesArray` internals: every field carries
 * `@IsOptional()` plus a type validator, and nest-cli.json declares no Swagger
 * CLI plugin, so all decorators are explicit.
 */
describe('UpdateVideoRoomSettingsDto', () => {
  it('declares exactly the writable settings fields', () => {
    const declared = new Set(
      getMetadataStorage()
        .getTargetValidationMetadatas(UpdateVideoRoomSettingsDto, '', false, false)
        .map((m) => m.propertyName),
    );

    expect([...declared].sort()).toEqual([...WRITABLE_SETTINGS_FIELDS].sort());
  });
});
