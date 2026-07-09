import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { ServerOptions } from 'socket.io';
import { RedisService } from '../redis/redis.service';

/**
 * Socket.IO adapter backed by Redis pub/sub so events fan out across every API
 * instance — required for horizontally-scaled realtime (rooms, live, chat).
 * Wired in main.ts before listen().
 *
 * Server-level options set here apply to every namespace: CORS, heartbeat
 * (ping) tuning, and connection-state recovery so short client drops replay
 * missed packets on reconnect.
 */
export class SocketAdapter extends IoAdapter {
  private readonly logger = new Logger(SocketAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const redis = this.app.get(RedisService);
    const pubClient = redis.duplicate();
    const subClient = redis.duplicate();
    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('Socket.IO Redis adapter connected');
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const config = this.app.get(ConfigService);
    const corsOrigins = config.get('app.corsOrigins', { infer: true });

    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: corsOrigins, credentials: true },
      // Heartbeat: server pings every 25s and expects a pong within 20s.
      pingInterval: 25_000,
      pingTimeout: 20_000,
      // Replay packets missed during brief disconnects (reconnection support).
      connectionStateRecovery: { maxDisconnectionDuration: 120_000 },
    });

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
