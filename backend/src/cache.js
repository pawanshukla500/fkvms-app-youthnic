/**
 * Simple bounded TTL cache for lookup results.
 * Prevents repeated database queries for the same barcode within the TTL window.
 */

export class TtlCache {
  constructor(ttlSeconds = 60, maxSize = 500) {
    this.ttlMs = ttlSeconds * 1000;
    this.maxSize = maxSize;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    // Evict oldest if at capacity
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }
    this.store.set(key, { value, createdAt: Date.now() });
  }

  clear() {
    this.store.clear();
  }

  size() {
    return this.store.size;
  }
}
