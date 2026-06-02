import { BehaviorSubject } from "rxjs";

/**
 * BehaviorSubject có lưu/khôi phục giá trị qua IndexedDB.
 *
 * Vì sao IndexedDB (không phải localStorage): các service (AuthService…) chạy trong
 * SharedWorker — nơi KHÔNG có `localStorage`, nhưng `indexedDB` thì có. Nhờ vậy state
 * sống sót qua F5 và cả khi SharedWorker bị huỷ rồi tạo lại (đóng hết tab).
 *
 * - Khởi tạo bằng `defaultValue` (đồng bộ) rồi hydrate giá trị đã lưu (bất đồng bộ);
 *   `await instance.hydrated` để biết đã đọc xong từ IndexedDB.
 * - Mỗi `next(value)` ghi đè giá trị xuống IndexedDB.
 * - Nếu môi trường không có IndexedDB → hoạt động y như BehaviorSubject thường.
 */
export class IndexedDBBehaviorSubject<T> extends BehaviorSubject<T> {
  private readonly key: string;
  private readonly storeName: string;
  private readonly dbReady: Promise<IDBDatabase | null>;
  /** Đánh dấu đã có `next()` chạy trước khi hydrate xong → không ghi đè bằng giá trị cũ trong DB. */
  private dirty = false;

  /** Resolve khi đã đọc xong giá trị ban đầu từ IndexedDB (hoặc xác định là chưa có). */
  readonly hydrated: Promise<void>;

  constructor(key: string, defaultValue: T, options: { dbName?: string; storeName?: string } = {}) {
    super(defaultValue);
    this.key = key;
    this.storeName = options.storeName ?? "kv";
    this.dbReady = this.openDb(options.dbName ?? "codex-livequery");
    this.hydrated = this.hydrate(defaultValue);
  }

  private openDb(dbName: string): Promise<IDBDatabase | null> {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return new Promise((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(dbName, 1);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(this.storeName)) {
          req.result.createObjectStore(this.storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }

  private async hydrate(defaultValue: T): Promise<void> {
    const db = await this.dbReady;
    if (!db) return;
    const stored = await new Promise<T | undefined>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readonly");
        const req = tx.objectStore(this.storeName).get(this.key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
    // Chỉ áp dụng giá trị từ DB nếu CHƯA có next() mới hơn trong lúc chờ (tránh lùi state).
    if (!this.dirty && stored !== undefined) {
      super.next(stored ?? defaultValue);
    }
  }

  override next(value: T): void {
    this.dirty = true;
    super.next(value);
    void this.persist(value);
  }

  private async persist(value: T): Promise<void> {
    const db = await this.dbReady;
    if (!db) return;
    try {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).put(value as unknown, this.key);
    } catch {
      /* ignore lỗi ghi (DB đóng, quota…) */
    }
  }
}
