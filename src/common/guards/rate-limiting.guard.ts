import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerStorage } from '@nestjs/throttler';
import { ModuleRef, Reflector } from '@nestjs/core';
import { ThrottlerRequest } from '@nestjs/throttler/dist/throttler.guard.interface';
import { ConfigurationEngineService } from '../../modules/platform-configuration/services/configuration-engine.service';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  private configService?: ConfigurationEngineService;

  constructor(
    options: any,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly moduleRef: ModuleRef,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }
    return req.ip || 'ip';
  }

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, limit, ttl } = requestProps;
    const http = context.switchToHttp();
    const req = http.getRequest();
    const path = req.path || '';

    // Dynamically resolve ConfigurationEngineService using moduleRef
    if (!this.configService) {
      try {
        this.configService = this.moduleRef.get(ConfigurationEngineService, { strict: false });
      } catch {
        // Fallback if not registered yet
      }
    }

    let finalLimit = limit;
    let finalTtl = ttl; // in milliseconds (we convert dynamic config seconds to ms)

    const isAuth =
      path.includes('/auth/login') ||
      path.includes('/auth/register') ||
      path.includes('/auth/refresh') ||
      path.includes('/auth/password-reset');

    const isOtp = path.includes('/otp/send') || path.includes('/otp/verify');

    if (this.configService) {
      try {
        if (isAuth) {
          finalLimit = await this.configService.getNumber('throttle.auth.limit', 10);
          const ttlSec = await this.configService.getNumber('throttle.auth.ttl', 60);
          finalTtl = ttlSec * 1000;
        } else if (isOtp) {
          finalLimit = await this.configService.getNumber('throttle.otp.limit', 3);
          const ttlSec = await this.configService.getNumber('throttle.otp.ttl', 60);
          finalTtl = ttlSec * 1000;
        } else {
          finalLimit = await this.configService.getNumber('throttle.global.limit', 100);
          const ttlSec = await this.configService.getNumber('throttle.global.ttl', 60);
          finalTtl = ttlSec * 1000;
        }
      } catch {
        finalLimit = isAuth ? 10 : isOtp ? 3 : 100;
        finalTtl = 60 * 1000;
      }
    } else {
      finalLimit = isAuth ? 10 : isOtp ? 3 : 100;
      finalTtl = 60 * 1000;
    }

    // Call super.handleRequest with updated properties
    return super.handleRequest({
      ...requestProps,
      limit: finalLimit,
      ttl: finalTtl,
    });
  }
}
