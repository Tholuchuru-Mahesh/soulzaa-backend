import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface LevelCalculationResult {
  currentLevel: number;
  currentLevelExp: bigint;
  nextLevelExp: bigint;
  expForCurrentLevel: bigint;
  expForNextLevel: bigint;
  progressPercentage: number;
  isMaxLevel: boolean;
}

@Injectable()
export class LevelCalculationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Calculates required cumulative EXP for a given level using standard curve if definition absent.
   */
  calculateExpForLevel(level: number): bigint {
    if (level <= 1) return BigInt(0);
    // Standard quadratic curve: 100 * (level - 1)^2
    return BigInt(Math.floor(100 * Math.pow(level - 1, 2)));
  }

  /**
   * Evaluates user level and progress based on cumulative lifetime EXP and LevelDefinition table.
   */
  async calculateUserLevel(
    totalExp: bigint,
    maxLevelLimit: number = 100,
  ): Promise<LevelCalculationResult> {
    const definitions = await this.prisma.levelDefinition.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { level: 'asc' },
    });

    let currentLevel = 1;
    let expForCurrentLevel = BigInt(0);
    let expForNextLevel = this.calculateExpForLevel(2);

    if (definitions.length > 0) {
      for (const def of definitions) {
        if (totalExp >= def.requiredExp && def.level <= maxLevelLimit) {
          currentLevel = def.level;
          expForCurrentLevel = def.requiredExp;
        } else {
          break;
        }
      }

      const nextDef = definitions.find(
        (d) => d.level === currentLevel + 1 && d.level <= maxLevelLimit,
      );
      if (nextDef) {
        expForNextLevel = nextDef.requiredExp;
      } else {
        expForNextLevel = expForCurrentLevel;
      }
    } else {
      // Dynamic mathematical formula fallback
      let lvl = 1;
      while (lvl < maxLevelLimit) {
        const nextThreshold = this.calculateExpForLevel(lvl + 1);
        if (totalExp >= nextThreshold) {
          lvl++;
        } else {
          break;
        }
      }
      currentLevel = lvl;
      expForCurrentLevel = this.calculateExpForLevel(currentLevel);
      expForNextLevel = this.calculateExpForLevel(currentLevel + 1);
    }

    const isMaxLevel = currentLevel >= maxLevelLimit || expForNextLevel === expForCurrentLevel;
    let progressPercentage = 100.0;

    if (!isMaxLevel && expForNextLevel > expForCurrentLevel) {
      const expInCurrentLevel = totalExp - expForCurrentLevel;
      const expNeeded = expForNextLevel - expForCurrentLevel;
      progressPercentage = Math.min(
        100.0,
        Math.max(0.0, (Number(expInCurrentLevel) / Number(expNeeded)) * 100),
      );
    }

    return {
      currentLevel,
      currentLevelExp: totalExp,
      nextLevelExp: expForNextLevel,
      expForCurrentLevel,
      expForNextLevel,
      progressPercentage: Number(progressPercentage.toFixed(2)),
      isMaxLevel,
    };
  }
}
