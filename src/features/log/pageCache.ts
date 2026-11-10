/**
 * Small LRU cache for pages of log rows (the log fetches pages of 200 rows; a few dozen pages stay in memory).
 * `get` refreshes the recency of a page; `set` evicts the least recently used page when full.
 */
export class PageCache<T> {
  private readonly pages = new Map<number, T>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.pages.size;
  }

  has(page: number): boolean {
    return this.pages.has(page);
  }

  get(page: number): T | undefined {
    const v = this.pages.get(page);
    if (v === undefined) return undefined;
    this.pages.delete(page);
    this.pages.set(page, v);
    return v;
  }

  /** Stores a page and returns the index of the evicted page, if any. */
  set(page: number, value: T): number | undefined {
    this.pages.delete(page);
    this.pages.set(page, value);
    if (this.pages.size <= this.capacity) return undefined;
    const oldest = this.pages.keys().next().value as number;
    this.pages.delete(oldest);
    return oldest;
  }

  clear(): void {
    this.pages.clear();
  }
}
