import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { DeviceController } from './controllers/device.controller';
import { DEVICE_QUEUES } from './device.constants';
import { DEVICE_SERVICE } from './interfaces/device.interface';
import { PushProcessor } from './processors/push.processor';
import { DeviceRepository } from './repositories/device.repository';
import { DeviceService } from './services/device.service';
import { PushDispatcher } from './services/push/push.dispatcher';
import { PushProviderRegistry } from './services/push/push-provider.registry';
import { ApnsPushProvider } from './services/push/providers/apns-push.provider';
import { ConsolePushProvider } from './services/push/providers/console-push.provider';
import { FcmPushProvider } from './services/push/providers/fcm-push.provider';

import { ModeratorDeviceChangeController } from './controllers/moderator-device-change.controller';
import { ModeratorDeviceBindingService } from './services/moderator-device-binding.service';

/**
 * Device Management domain — the device registry, trust ledger and audit trail
 * (user_devices / trusted_devices / device_history), registration + suspicious-
 * login detection, verification/naming/removal, push-token management, and
 * multi-provider push delivery (FCM/APNS/console) over a dedicated BullMQ queue.
 *
 * @Global so the session module resolves DEVICE_SERVICE by the interface token
 * without importing this module. Registers its own `push` queue off the shared
 * BullMQ connection from the global QueueModule.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: DEVICE_QUEUES.PUSH })],
  controllers: [DeviceController, ModeratorDeviceChangeController],
  providers: [
    DeviceRepository,
    DeviceService,
    PushDispatcher,
    PushProviderRegistry,
    ConsolePushProvider,
    FcmPushProvider,
    ApnsPushProvider,
    PushProcessor,
    ModeratorDeviceBindingService,
    { provide: DEVICE_SERVICE, useExisting: DeviceService },
  ],
  exports: [DEVICE_SERVICE, DeviceRepository, PushDispatcher, ModeratorDeviceBindingService],
})
export class DeviceModule {}
