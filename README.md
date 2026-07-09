# Soulzaa Backend

Social entertainment platform backend — **NestJS modular monolith**, built to be split into microservices later without rewrites.

> **Phase 0**: architecture + infrastructure only. Every domain module is scaffolded but empty — no business logic yet.

## Stack

| Concern        | Choice                                             |
| -------------- | -------------------------------------------------- |
| Framework      | NestJS 11 (TypeScript)                             |
| Database       | PostgreSQL + Prisma (multi-file schema)           |
| Cache/realtime | Redis (ioredis) — cache, presence, locks, ZSETs   |
| Realtime       | Socket.IO + `@socket.io/redis-adapter`            |
| Jobs           | BullMQ                                             |
| Media          | AWS S3 (presigned URLs)                            |
| Audio/Video    | Agora (RTC/RTM tokens)                             |
| Docs           | Swagger / OpenAPI (`/api-docs`)                   |
| Observability  | pino logs + Prometheus `/metrics` + Terminus health |

## Architecture

```
src/
  config/     env validation (Zod) + typed config namespaces
  common/     cross-cutting: event bus, guards, decorators, filters, interceptors, DTOs
  infra/      Prisma, Redis, Queue, Storage(S3), Socket, Agora, Auth, Health, Observability
  modules/    16 domain modules (auth, users, wallet, payments, chat, audio-rooms,
              gifts, rankings, treasure-boxes, video-rooms, live-streaming, vip,
              families, agencies, games, analytics)
prisma/schema/  one .prisma file per module (prismaSchemaFolder)
```

**Boundaries (enforced by `pnpm boundaries`):**

- Domain modules **never import each other** — they communicate through the `EVENT_BUS`
  (`src/common/events`). In-process today; swap the binding to Redis/Kafka to extract a
  service, with zero call-site changes.
- `infra` and `common` must not depend on `modules`.
- Each module owns its Prisma models. No cross-module DB relations by default.

## Getting started

```bash
# 1. Install
pnpm install

# 2. Configure
cp .env.example .env    # adjust secrets as needed

# 3. Start Postgres + Redis
docker compose up -d postgres redis

# 4. Generate client + apply schema
pnpm prisma:generate
pnpm prisma migrate dev --name init

# 5. Run
pnpm start:dev
```

Then:

- API prefix: `http://localhost:3000/api`
- Swagger: `http://localhost:3000/api-docs`
- Liveness: `http://localhost:3000/health`
- Readiness: `http://localhost:3000/health/ready`
- Metrics: `http://localhost:3000/metrics`
- Probes: `GET /api/ping` (public), `GET /api/me` (JWT-guarded)

## Scripts

| Script                | Purpose                                  |
| --------------------- | ---------------------------------------- |
| `pnpm start:dev`      | Watch-mode dev server                    |
| `pnpm build`          | Compile to `dist/`                       |
| `pnpm lint`           | ESLint (zero-warning gate)               |
| `pnpm boundaries`     | Enforce module boundaries                |
| `pnpm test`           | Unit tests                               |
| `pnpm test:e2e`       | E2E smoke test (needs Postgres + Redis)  |
| `pnpm prisma:generate`| Generate Prisma client                   |
| `pnpm prisma:migrate` | Create/apply a dev migration             |
| `pnpm prisma:studio`  | Prisma Studio                            |

## Full stack in Docker

```bash
docker compose --profile full up --build
```

## Adding a domain module (later phases)

1. Add models to `prisma/schema/<module>.prisma`, then `pnpm prisma:migrate`.
2. Implement controllers/services/DTOs inside `src/modules/<module>/`.
3. Emit/consume cross-domain changes via `EVENT_BUS` — never import another module.
4. Register queues with `BullModule.registerQueue`, gateways extend `BaseGateway`.
5. `pnpm boundaries && pnpm lint && pnpm build` stays green.
