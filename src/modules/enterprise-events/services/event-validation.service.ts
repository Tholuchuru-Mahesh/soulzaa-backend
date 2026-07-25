import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EVENT_CATEGORIES, EVENT_STATUSES } from '../constants/event.constants';

@Injectable()
export class EventValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async validateUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);
  }

  async validateEventExists(eventId: string) {
    const def = await this.prisma.eventDefinition.findUnique({ where: { id: eventId } });
    if (!def) throw new NotFoundException(`Event definition ${eventId} not found`);
    return def;
  }

  async validateEventByCode(code: string) {
    const def = await this.prisma.eventDefinition.findUnique({ where: { code } });
    if (!def) throw new NotFoundException(`Event with code '${code}' not found`);
    return def;
  }

  validateCategory(category: string): void {
    if (!(EVENT_CATEGORIES as readonly string[]).includes(category)) {
      throw new BadRequestException(
        `Invalid event category '${category}'. Valid: ${EVENT_CATEGORIES.join(', ')}`,
      );
    }
  }

  validateStatus(status: string): void {
    if (!(EVENT_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(
        `Invalid event status '${status}'. Valid: ${EVENT_STATUSES.join(', ')}`,
      );
    }
  }

  validateTimeWindows(
    startTime: Date,
    endTime: Date,
    regStartTime?: Date,
    regEndTime?: Date,
  ): void {
    if (endTime <= startTime) {
      throw new BadRequestException('End time must be after start time');
    }
    if (regStartTime && regEndTime && regEndTime <= regStartTime) {
      throw new BadRequestException('Registration end time must be after registration start time');
    }
    if (regEndTime && regEndTime > endTime) {
      throw new BadRequestException('Registration end time cannot be after event end time');
    }
  }

  async validateCapacity(eventId: string, maxParticipants: number): Promise<void> {
    const count = await this.prisma.eventRegistration.count({
      where: { eventId, status: 'REGISTERED' },
    });
    if (count >= maxParticipants) {
      throw new BadRequestException(`Event capacity of ${maxParticipants} participants reached`);
    }
  }

  async validateNotAlreadyRegistered(eventId: string, userId: string): Promise<void> {
    const existing = await this.prisma.eventRegistration.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });
    if (existing && existing.status === 'REGISTERED') {
      throw new BadRequestException(`User ${userId} is already registered for event ${eventId}`);
    }
  }

  async validateRegistrationWindow(def: any): Promise<void> {
    const now = new Date();
    if (
      def.status !== 'REGISTRATION_OPEN' &&
      def.status !== 'SCHEDULED' &&
      def.status !== 'ACTIVE'
    ) {
      throw new BadRequestException(
        `Event ${def.id} is not accepting registrations (Status: ${def.status})`,
      );
    }
    if (def.regStartTime && now < new Date(def.regStartTime)) {
      throw new BadRequestException(`Registration window for event ${def.id} has not opened yet`);
    }
    if (def.regEndTime && now > new Date(def.regEndTime)) {
      throw new BadRequestException(`Registration window for event ${def.id} has closed`);
    }
  }
}
