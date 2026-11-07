import type { Page } from '@playwright/test';

/**
 * Flips the last byte, inside the AEAD tag, of every stored record of `recordType` (keys
 * `[recordType, recordId]`, D158), as a disk could. A vault already open keeps its records in
 * memory; what it sends is read again from storage and verified (D181). Returns how many changed.
 */
export function corruptRecords(page: Page, recordType: number): Promise<number> {
  return page.evaluate(async (type) => {
    const [info] = (await indexedDB.databases()).filter((d) => d.name?.startsWith('blindvault-'));
    const name = info?.name;
    if (!name) throw new Error('no vault database');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error('open failed'));
      };
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        let changed = 0;
        const tx = db.transaction('records', 'readwrite');
        const request = tx.objectStore('records').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if ((cursor.key as unknown[])[0] === type) {
            const bytes = new Uint8Array(cursor.value as Uint8Array);
            bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
            cursor.update(bytes);
            changed++;
          }
          cursor.continue();
        };
        tx.oncomplete = () => {
          resolve(changed);
        };
        tx.onerror = () => {
          reject(new Error('write failed'));
        };
      });
    } finally {
      db.close();
    }
  }, recordType);
}
