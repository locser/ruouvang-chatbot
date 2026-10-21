import { createClient } from "redis";
import { env } from "../config/env";

// In-memory cache fallback for testing/dev
class MemoryCache {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt && item.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async flush(): Promise<void> {
    this.store.clear();
  }
}

let redisClient: ReturnType<typeof createClient> | null = null;
const memoryCacheFallback = new MemoryCache();

// Initialize Redis if configured
if (env.REDIS_URL && env.NODE_ENV !== "test") {
  redisClient = createClient({ url: env.REDIS_URL });
  redisClient.on("error", (err) => console.error("Redis Cache Client Error", err));
  redisClient.connect().catch((err) => {
    console.warn("Failed to connect to Redis. Falling back to memory cache.", err);
    redisClient = null;
  });
}

/**
 * Build a tenant-scoped cache key to prevent cross-tenant data leakage.
 */
export function buildTenantCacheKey(tenantId: string, namespace: string, key: string): string {
  return `tenant:${tenantId}:${namespace}:${key}`;
}

export const cache = {
  async get(key: string): Promise<string | null> {
    if (redisClient?.isOpen) {
      try {
        return await redisClient.get(key);
      } catch (e) {
        console.error("Redis GET failed, falling back to memory:", e);
      }
    }
    return await memoryCacheFallback.get(key);
  },

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (redisClient?.isOpen) {
      try {
        if (ttlSeconds) {
          await redisClient.set(key, value, { EX: ttlSeconds });
        } else {
          await redisClient.set(key, value);
        }
        return;
      } catch (e) {
        console.error("Redis SET failed, falling back to memory:", e);
      }
    }
    await memoryCacheFallback.set(key, value, ttlSeconds);
  },

  async del(key: string): Promise<void> {
    if (redisClient?.isOpen) {
      try {
        await redisClient.del(key);
        return;
      } catch (e) {
        console.error("Redis DEL failed, falling back to memory:", e);
      }
    }
    await memoryCacheFallback.del(key);
  },

  async flush(): Promise<void> {
    if (redisClient?.isOpen) {
      try {
        await redisClient.flushAll();
        return;
      } catch (e) {
        console.error("Redis FLUSH failed, falling back to memory:", e);
      }
    }
    await memoryCacheFallback.flush();
  }
};
