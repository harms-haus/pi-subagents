/** Generic TTL-based cache for single-key lookups */
export class TtlCache<T> {
  private entry: { key: string; data: T; timestamp: number } | null = null;

  constructor(private ttl: number) {}

  get(key: string): T | undefined {
    if (this.entry && this.entry.key === key) {
      if (Date.now() - this.entry.timestamp < this.ttl) {
        return this.entry.data;
      }
      this.entry = null; // Allow GC of stale data
    }
    return undefined;
  }

  set(key: string, data: T): void {
    this.entry = { key, data, timestamp: Date.now() };
  }

  invalidate(): void {
    this.entry = null;
  }
}
