import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class AssignUserLocationDto {
  @ApiPropertyOptional({ description: 'Country id; null clears it' })
  @IsOptional()
  @IsUUID()
  countryId?: string | null;

  @ApiPropertyOptional({ description: 'State id; must belong to the country' })
  @IsOptional()
  @IsUUID()
  stateId?: string | null;

  @ApiPropertyOptional({ description: 'Region id; must belong to the state' })
  @IsOptional()
  @IsUUID()
  regionId?: string | null;
}
