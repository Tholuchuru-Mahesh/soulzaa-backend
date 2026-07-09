import type { Cluster, Redis } from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * The shared connection is either a standalone client (today) or a Cluster
 * client (future multi-node deployment). Both expose the same ioredis command
 * surface, so services type against this union and never branch on topology.
 * Keep multi-key operations cluster-safe: co-locate related keys with a
 * `{hash-tag}` or issue one command per key (see CacheService.del / PresenceService).
 */
export type RedisClient = Redis | Cluster;
