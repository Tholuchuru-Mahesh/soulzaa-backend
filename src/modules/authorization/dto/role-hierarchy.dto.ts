import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class CreateRoleHierarchyDto {
  @ApiProperty({
    description: 'Parent Role ID (inherits child role capabilities)',
    example: '123e4567-e89b-12d3-a456-426614174001',
  })
  @IsUUID()
  @IsNotEmpty()
  parentRoleId!: string;

  @ApiProperty({ description: 'Child Role ID', example: '123e4567-e89b-12d3-a456-426614174002' })
  @IsUUID()
  @IsNotEmpty()
  childRoleId!: string;
}
