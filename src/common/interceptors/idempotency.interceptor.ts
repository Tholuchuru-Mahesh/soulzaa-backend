import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  ConflictException,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { REDIS_CLIENT, RedisClient } from '../../infra/redis/redis.constants';
import * as crypto from 'crypto';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers['x-idempotency-key'];

    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return next.handle();
    }

    const userId = request.user?.id ?? 'anonymous';
    const redisKey = `idempotency:${userId}:${idempotencyKey}`;

    const requestBodyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(request.body ?? {}))
      .digest('hex');

    const cachedPayload = await this.redis.get(redisKey);
    if (cachedPayload) {
      const parsed = JSON.parse(cachedPayload);
      if (parsed.hash !== requestBodyHash) {
        throw new ConflictException('Idempotency key payload mismatch');
      }
      return of(parsed.response);
    }

    return next.handle().pipe(
      tap(async (response) => {
        const payload = JSON.stringify({
          hash: requestBodyHash,
          response,
          timestamp: new Date().toISOString(),
        });
        await this.redis.set(redisKey, payload, 'EX', 86400); // 24 hour TTL
      }),
    );
  }
}
