import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

export interface SetPreferenceInput {
  userId: string;
  type: string;
  channel: string;
  enabled: boolean;
}

@Injectable()
export class NotificationPreferenceService {
  constructor(private readonly prisma: PrismaService) {}

  async set(input: SetPreferenceInput): Promise<unknown> {
    return this.prisma.enterpriseNotificationPreference.upsert({
      where: {
        userId_type_channel: {
          userId: input.userId,
          type: input.type,
          channel: input.channel,
        },
      },
      create: {
        userId: input.userId,
        type: input.type,
        channel: input.channel,
        enabled: input.enabled,
      },
      update: {
        enabled: input.enabled,
      },
    });
  }

  async isEnabled(userId: string, type: string, channel: string): Promise<boolean> {
    const preference = await this.prisma.enterpriseNotificationPreference.findUnique({
      where: {
        userId_type_channel: {
          userId,
          type,
          channel,
        },
      },
    });
    if (!preference) return true; // Default to enabled
    return preference.enabled;
  }

  async getPreferences(userId: string): Promise<unknown[]> {
    return this.prisma.enterpriseNotificationPreference.findMany({
      where: { userId },
    });
  }
}
