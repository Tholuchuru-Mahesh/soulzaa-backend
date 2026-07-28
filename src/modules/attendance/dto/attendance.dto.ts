import { ApiProperty } from '@nestjs/swagger';

export class AttendanceLadderRungDto {
  @ApiProperty({ example: 7 }) day!: number;
  @ApiProperty({ example: 500 }) coins!: number;
  @ApiProperty({ example: 100, nullable: true }) expAmount!: number | null;
  @ApiProperty({ nullable: true }) cosmeticId!: string | null;
}

export class AttendanceStatusDto {
  @ApiProperty({ example: 3 }) currentDay!: number;
  @ApiProperty({ example: 0 }) cycleCount!: number;
  @ApiProperty({ example: true }) claimableToday!: boolean;
  @ApiProperty({ example: 4, nullable: true }) nextDay!: number | null;
  @ApiProperty({ example: 'Asia/Kolkata' }) timezone!: string;
  @ApiProperty() nextClaimAt!: Date;
  @ApiProperty({ type: [AttendanceLadderRungDto] }) ladder!: AttendanceLadderRungDto[];
}

export class AttendanceClaimDto {
  @ApiProperty({ example: true, description: 'False when today was already claimed' })
  claimed!: boolean;
  @ApiProperty({ example: 4 }) day!: number;
  @ApiProperty({ example: 0 }) cycle!: number;
  @ApiProperty({ example: 250 }) coins!: number;
  @ApiProperty({ example: null, nullable: true }) expAwarded!: number | null;
  @ApiProperty({ nullable: true }) cosmeticId!: string | null;
  @ApiProperty({ example: false }) streakReset!: boolean;
  @ApiProperty() nextClaimAt!: Date;
}
