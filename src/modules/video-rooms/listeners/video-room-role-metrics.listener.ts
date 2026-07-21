import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  VIDEO_ROOM_ROLE_EVENTS,
  type OwnershipTransferredEvent,
  type RoleAssignedEvent,
  type RoleRemovedEvent,
  type RoleUpdatedEvent,
} from '../events/video-room-role.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * Role & ownership events → Prometheus counters (VR-7). Kept as a listener rather
 * than inlined in the services so monitoring stays off the write path: a metrics
 * failure can never fail a role grant. Mirrors the VR-4 seat and VR-5 media
 * metrics listeners.
 */
@Injectable()
export class VideoRoomRoleMetricsListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoleAssignedEvent>(VIDEO_ROOM_ROLE_EVENTS.ROLE_ASSIGNED, (event) =>
      this.metrics.incRoleAssignment(event.payload.role, 'assigned'),
    );
    this.bus.subscribe<RoleRemovedEvent>(VIDEO_ROOM_ROLE_EVENTS.ROLE_REMOVED, (event) =>
      this.metrics.incRoleAssignment(event.payload.role, 'removed'),
    );
    this.bus.subscribe<RoleUpdatedEvent>(VIDEO_ROOM_ROLE_EVENTS.ROLE_UPDATED, (event) =>
      this.metrics.incRoleAssignment(event.payload.role, 'updated'),
    );
    this.bus.subscribe<OwnershipTransferredEvent>(
      VIDEO_ROOM_ROLE_EVENTS.OWNERSHIP_TRANSFERRED,
      () => this.metrics.incOwnershipTransfer(),
    );
    this.bus.subscribe(VIDEO_ROOM_ROLE_EVENTS.TEMPORARY_ROLE_GRANTED, () =>
      this.metrics.incTemporaryRole('granted'),
    );
    this.bus.subscribe(VIDEO_ROOM_ROLE_EVENTS.TEMPORARY_ROLE_EXPIRED, () =>
      this.metrics.incTemporaryRole('expired'),
    );
  }
}
