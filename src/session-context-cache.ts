/**
 * Session Context Cache
 *
 * Manages Suite context caching with TTL-based cleanup and selective injection logic.
 * Context is only injected for:
 * - First message in a session
 * - After long gaps (>5 minutes of inactivity)
 * - When the conversation context window is approaching limits
 */

export interface CacheEntry {
  context: any;
  createdAt: number;
  lastAccessedAt: number;
  messageCount: number;
}

export interface CacheConfig {
  ttlMs: number;
  maxEntries: number;
  inactivityThresholdMs: number;
  contextWindowWarningTokens: number;
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  ttlMs: 30 * 60 * 1000, // 30 minutes
  maxEntries: 1000,
  inactivityThresholdMs: 5 * 60 * 1000, // 5 minutes
  contextWindowWarningTokens: 4000, // Warn when context approaches this limit
};

export class SessionContextCache {
  private cache = new Map<string, CacheEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: CacheConfig = DEFAULT_CACHE_CONFIG) {
    this.startCleanupInterval();
  }

  /**
   * Get context for a session key if it should be injected
   * Returns null if context should not be injected based on:
   * - Not first message AND not after long gap AND context window not near limit
   */
  getContextForInjection(
    sessionKey: string,
    currentContextTokens?: number
  ): { context: any; isFirstMessage: boolean; reason: string } | null {
    const entry = this.cache.get(sessionKey);
    if (!entry) return null;

    const now = Date.now();
    const isFirstMessage = entry.messageCount === 0;
    const timeSinceLastAccess = now - entry.lastAccessedAt;
    const isAfterLongGap = timeSinceLastAccess > this.config.inactivityThresholdMs;
    const isNearContextLimit = currentContextTokens !== undefined &&
      currentContextTokens > this.config.contextWindowWarningTokens;

    // Update access tracking
    entry.lastAccessedAt = now;
    entry.messageCount++;

    // Decide whether to inject context
    const shouldInject = isFirstMessage || isAfterLongGap || isNearContextLimit;

    if (!shouldInject) {
      return null;
    }

    let reason: string;
    if (isFirstMessage) {
      reason = "first message in session";
    } else if (isAfterLongGap) {
      reason = `after ${Math.round(timeSinceLastAccess / 1000 / 60)} min inactivity`;
    } else {
      reason = "context window approaching limit";
    }

    return { context: entry.context, isFirstMessage, reason };
  }

  /**
   * Store context for a session key
   */
  setContext(sessionKey: string, context: any): void {
    // Enforce max entries by removing oldest
    if (this.cache.size >= this.config.maxEntries && !this.cache.has(sessionKey)) {
      this.evictOldest();
    }

    const now = Date.now();
    this.cache.set(sessionKey, {
      context,
      createdAt: now,
      lastAccessedAt: now,
      messageCount: 0,
    });
  }

  /**
   * Remove a session from the cache (e.g., when session ends)
   */
  removeSession(sessionKey: string): boolean {
    return this.cache.delete(sessionKey);
  }

  /**
   * Get raw cache entry without modifying state
   */
  getEntry(sessionKey: string): CacheEntry | undefined {
    return this.cache.get(sessionKey);
  }

  /**
   * Check if a session exists in cache
   */
  hasSession(sessionKey: string): boolean {
    return this.cache.has(sessionKey);
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; oldestEntryAgeMs: number | null } {
    let oldest = Infinity;
    for (const entry of this.cache.values()) {
      if (entry.createdAt < oldest) {
        oldest = entry.createdAt;
      }
    }
    return {
      size: this.cache.size,
      oldestEntryAgeMs: oldest === Infinity ? null : Date.now() - oldest,
    };
  }

  /**
   * Manually trigger cleanup of expired entries
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.lastAccessedAt > this.config.ttlMs) {
        this.cache.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Clear all entries and stop cleanup interval
   */
  destroy(): void {
    this.stopCleanupInterval();
    this.cache.clear();
  }

  /**
   * Get all session keys (for testing/monitoring)
   */
  getSessionKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  private startCleanupInterval(): void {
    // Run cleanup every 5 minutes
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);

    // Ensure timer doesn't keep process alive
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  private stopCleanupInterval(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}

// Global cache instance
let globalCache: SessionContextCache | null = null;

export function getSessionContextCache(): SessionContextCache {
  if (!globalCache) {
    globalCache = new SessionContextCache();
  }
  return globalCache;
}

export function resetSessionContextCache(): void {
  if (globalCache) {
    globalCache.destroy();
  }
  globalCache = new SessionContextCache();
}

// For testing: inject a mock cache
export function setSessionContextCache(cache: SessionContextCache): void {
  if (globalCache) {
    globalCache.destroy();
  }
  globalCache = cache;
}
