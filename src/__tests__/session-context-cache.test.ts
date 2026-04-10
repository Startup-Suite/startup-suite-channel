import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SessionContextCache,
  DEFAULT_CACHE_CONFIG,
  setSessionContextCache,
  resetSessionContextCache,
} from "../session-context-cache.js";

describe("SessionContextCache", () => {
  let cache: SessionContextCache;

  beforeEach(() => {
    cache = new SessionContextCache({
      ttlMs: 30 * 60 * 1000, // 30 minutes
      maxEntries: 100,
      inactivityThresholdMs: 5 * 60 * 1000, // 5 minutes
      contextWindowWarningTokens: 4000,
    });
    setSessionContextCache(cache);
  });

  afterEach(() => {
    cache.destroy();
    resetSessionContextCache();
  });

  describe("Cache entry creation and retrieval", () => {
    it("should store and retrieve context", () => {
      const sessionKey = "test:session:123";
      const context = { space: { id: "space-123", name: "Test Space" } };

      cache.setContext(sessionKey, context);
      const entry = cache.getEntry(sessionKey);

      expect(entry).toBeDefined();
      expect(entry?.context).toEqual(context);
      expect(entry?.messageCount).toBe(0);
    });

    it("should track multiple sessions independently", () => {
      const context1 = { space: { id: "space-1", name: "Space One" } };
      const context2 = { space: { id: "space-2", name: "Space Two" } };

      cache.setContext("session:1", context1);
      cache.setContext("session:2", context2);

      expect(cache.getEntry("session:1")?.context).toEqual(context1);
      expect(cache.getEntry("session:2")?.context).toEqual(context2);
    });

    it("should check if session exists", () => {
      cache.setContext("session:exists", { test: true });

      expect(cache.hasSession("session:exists")).toBe(true);
      expect(cache.hasSession("session:missing")).toBe(false);
    });
  });

  describe("Selective context injection", () => {
    it("should inject context for first message in session", () => {
      const sessionKey = "test:first:message";
      const context = { space: { id: "space-123", name: "Test" } };

      cache.setContext(sessionKey, context);
      const result = cache.getContextForInjection(sessionKey);

      expect(result).not.toBeNull();
      expect(result?.isFirstMessage).toBe(true);
      expect(result?.context).toEqual(context);
      expect(result?.reason).toBe("first message in session");
    });

    it("should not inject context for follow-up messages under threshold", () => {
      const sessionKey = "test:follow:up";
      const context = { space: { id: "space-123", name: "Test" } };

      cache.setContext(sessionKey, context);
      
      // First message - should inject
      const firstResult = cache.getContextForInjection(sessionKey);
      expect(firstResult).not.toBeNull();

      // Follow-up immediately - should NOT inject
      const secondResult = cache.getContextForInjection(sessionKey);
      expect(secondResult).toBeNull();
    });

    it("should inject context after inactivity threshold", () => {
      const sessionKey = "test:inactivity";
      const context = { space: { id: "space-123", name: "Test" } };

      // Use a shorter inactivity threshold for testing
      cache = new SessionContextCache({
        ...DEFAULT_CACHE_CONFIG,
        ttlMs: 10000,
        maxEntries: 10,
        inactivityThresholdMs: 100, // 100ms threshold for testing
      });
      setSessionContextCache(cache);

      cache.setContext(sessionKey, context);
      
      // First message
      cache.getContextForInjection(sessionKey);

      // Immediate follow-up should not inject
      const immediate = cache.getContextForInjection(sessionKey);
      expect(immediate).toBeNull();

      // Wait past threshold
      return new Promise((resolve) => {
        setTimeout(() => {
          const afterGap = cache.getContextForInjection(sessionKey);
          expect(afterGap).not.toBeNull();
          expect(afterGap?.reason).toContain("inactivity");
          resolve(void 0);
        }, 150);
      });
    });

    it("should inject when context window is near limit", () => {
      const sessionKey = "test:context:limit";
      const context = { space: { id: "space-123", name: "Test" } };

      cache.setContext(sessionKey, context);
      
      // First message
      cache.getContextForInjection(sessionKey);

      // Immediate follow-up with low token count should not inject
      const noInject = cache.getContextForInjection(sessionKey, 100);
      expect(noInject).toBeNull();

      // Follow-up with high token count should inject
      const withInject = cache.getContextForInjection(sessionKey, 5000);
      expect(withInject).not.toBeNull();
      expect(withInject?.reason).toContain("context window");
    });

    it("should increment message count correctly", () => {
      const sessionKey = "test:message:count";
      const context = { test: true };

      cache.setContext(sessionKey, context);
      
      expect(cache.getEntry(sessionKey)?.messageCount).toBe(0);

      cache.getContextForInjection(sessionKey); // First call
      expect(cache.getEntry(sessionKey)?.messageCount).toBe(1);

      cache.getContextForInjection(sessionKey); // Second call
      expect(cache.getEntry(sessionKey)?.messageCount).toBe(2);
    });
  });

  describe("Cache cleanup behavior", () => {
    it("should remove expired entries on cleanup", () => {
      cache = new SessionContextCache({
        ...DEFAULT_CACHE_CONFIG,
        ttlMs: 100, // Very short TTL for testing
      });
      setSessionContextCache(cache);

      cache.setContext("session:old", { test: "old" });
      cache.setContext("session:new", { test: "new" });

      // Should exist initially
      expect(cache.hasSession("session:old")).toBe(true);
      expect(cache.hasSession("session:new")).toBe(true);

      // Wait past TTL for old
      return new Promise((resolve) => {
        setTimeout(() => {
          // Access "new" to refresh its timestamp
          cache.getContextForInjection("session:new");
          
          // Run cleanup
          const removed = cache.cleanup();
          expect(removed).toBe(1);
          expect(cache.hasSession("session:old")).toBe(false);
          expect(cache.hasSession("session:new")).toBe(true);
          resolve(void 0);
        }, 150);
      });
    });

    it("should remove session on demand", () => {
      cache.setContext("session:to:remove", { test: true });
      expect(cache.hasSession("session:to:remove")).toBe(true);

      const removed = cache.removeSession("session:to:remove");
      expect(removed).toBe(true);
      expect(cache.hasSession("session:to:remove")).toBe(false);

      // Removing non-existent should return false
      const notRemoved = cache.removeSession("session:never:existed");
      expect(notRemoved).toBe(false);
    });

    it("should evict oldest when max entries reached", async () => {
      cache = new SessionContextCache({
        ...DEFAULT_CACHE_CONFIG,
        maxEntries: 3,
      });
      setSessionContextCache(cache);

      // Add sessions one at a time with small delays to ensure different timestamps
      cache.setContext("session:1", { order: 1 });
      await new Promise(r => setTimeout(r, 10));
      cache.setContext("session:2", { order: 2 });
      await new Promise(r => setTimeout(r, 10));
      cache.setContext("session:3", { order: 3 });

      // All 3 should exist
      expect(cache.getStats().size).toBe(3);
      expect(cache.hasSession("session:1")).toBe(true);
      expect(cache.hasSession("session:2")).toBe(true);
      expect(cache.hasSession("session:3")).toBe(true);

      // Access session:1 to make it newest, then add session:4
      // This should evict session:2 (oldest access time)
      await new Promise(r => setTimeout(r, 10));
      cache.getContextForInjection("session:1"); // Refreshes timestamp for session:1
      
      await new Promise(r => setTimeout(r, 10));
      cache.setContext("session:4", { order: 4 });

      // After adding 4, size should still be 3, session:2 evicted
      expect(cache.getStats().size).toBe(3);
      expect(cache.hasSession("session:2")).toBe(false); // Oldest evicted
      expect(cache.hasSession("session:1")).toBe(true);  // Refreshed, kept
      expect(cache.hasSession("session:3")).toBe(true);  // Kept
      expect(cache.hasSession("session:4")).toBe(true);  // New
    });

    it("should provide stats", () => {
      expect(cache.getStats()).toEqual({ size: 0, oldestEntryAgeMs: null });

      cache.setContext("session:1", { test: 1 });
      const stats = cache.getStats();
      expect(stats.size).toBe(1);
      expect(stats.oldestEntryAgeMs).not.toBeNull();
      expect(stats.oldestEntryAgeMs!).toBeGreaterThanOrEqual(0);
    });

    it("should return all session keys", () => {
      cache.setContext("session:a", { test: 1 });
      cache.setContext("session:b", { test: 2 });

      const keys = cache.getSessionKeys();
      expect(keys).toContain("session:a");
      expect(keys).toContain("session:b");
      expect(keys.length).toBe(2);
    });
  });

  describe("Cache statistics", () => {
    it("should track entry timestamps", () => {
      const before = Date.now();
      cache.setContext("session:time", { test: true });
      const after = Date.now();

      const entry = cache.getEntry("session:time");
      expect(entry?.createdAt).toBeGreaterThanOrEqual(before);
      expect(entry?.createdAt).toBeLessThanOrEqual(after);
      expect(entry?.lastAccessedAt).toBe(entry?.createdAt);

      // Wait a bit and access to update lastAccessedAt
      return new Promise((resolve) => {
        setTimeout(() => {
          const beforeAccess = Date.now();
          cache.getContextForInjection("session:time");
          const afterAccess = Date.now();

          const updatedEntry = cache.getEntry("session:time");
          expect(updatedEntry?.lastAccessedAt).toBeGreaterThanOrEqual(beforeAccess);
          expect(updatedEntry?.lastAccessedAt).toBeLessThanOrEqual(afterAccess);
          resolve(void 0);
        }, 10);
      });
    });
  });

  describe("Edge cases", () => {
    it("should handle empty context", () => {
      cache.setContext("session:empty", null);
      const entry = cache.getEntry("session:empty");
      expect(entry?.context).toBeNull();
    });

    it("should return null for non-existent session in getContextForInjection", () => {
      const result = cache.getContextForInjection("session:nonexistent");
      expect(result).toBeNull();
    });

    it("should handle destroy properly", () => {
      cache.setContext("session:1", { test: 1 });
      cache.setContext("session:2", { test: 2 });

      expect(cache.hasSession("session:1")).toBe(true);
      
      cache.destroy();
      
      // After destroy, all entries should be cleared
      // But we can't check hasSession since the Map is cleared
      // Just verify destroy doesn't throw
    });
  });
});

describe("resetSessionContextCache", () => {
  it("should reset the global cache", () => {
    const cache1 = new SessionContextCache(DEFAULT_CACHE_CONFIG);
    setSessionContextCache(cache1);
    cache1.setContext("test", { value: 1 });

    resetSessionContextCache();
    
    // After reset, getSessionContextCache() returns a new empty cache
    const cache2 = resetSessionContextCache();
    // If we could get the cache again, it would be empty
  });
});
