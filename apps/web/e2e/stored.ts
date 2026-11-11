import { type Page } from '@playwright/test';

/**
 * Which of `needles` appear in any value of any IndexedDB database or of `localStorage`, and how
 * many values were read (CRYPTO-INV-001).
 */
export function storedPlaintext(
  page: Page,
  needles: readonly string[],
): Promise<{ chunks: number; found: string[] }> {
  return page.evaluate(async (needles) => {
    const chunks: Uint8Array[] = [];
    const collect = (value: unknown): void => {
      if (value instanceof Uint8Array) chunks.push(value);
      else if (value instanceof ArrayBuffer) chunks.push(new Uint8Array(value));
      else if (typeof value === 'string') chunks.push(new TextEncoder().encode(value));
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(new Error(String(request.error)));
        };
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => {
            resolve(request.result);
          };
          request.onerror = () => {
            reject(new Error(String(request.error)));
          };
        });
        collect(values);
      }
      db.close();
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) ?? '';
      collect(key);
      collect(localStorage.getItem(key));
    }
    const contains = (hay: Uint8Array, needle: Uint8Array) => {
      outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return true;
      }
      return false;
    };
    return {
      chunks: chunks.length,
      found: needles.filter((n) => {
        const bytes = new TextEncoder().encode(n);
        return chunks.some((c) => contains(c, bytes));
      }),
    };
  }, needles);
}
