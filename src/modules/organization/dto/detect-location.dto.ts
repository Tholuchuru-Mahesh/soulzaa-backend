import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsOptional, IsUUID } from 'class-validator';

/**
 * Self-service location capture. Either `latitude`/`longitude` (GPS path,
 * reverse-geocoded server-side) or a direct `countryId`/`stateId`/`regionId`
 * (manual-picker fallback, same shape as the admin `AssignUserLocationDto`) —
 * never both. `LocationDetectionService.detectAndAssign` picks the branch.
 */
export class DetectLocationDto {
  @ApiPropertyOptional({ description: 'GPS latitude, paired with longitude' })
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ description: 'GPS longitude, paired with latitude' })
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ description: 'Manual fallback: country id' })
  @IsOptional()
  @IsUUID()
  countryId?: string;

  @ApiPropertyOptional({ description: 'Manual fallback: state id' })
  @IsOptional()
  @IsUUID()
  stateId?: string;

  @ApiPropertyOptional({ description: 'Manual fallback: region id' })
  @IsOptional()
  @IsUUID()
  regionId?: string;
}
