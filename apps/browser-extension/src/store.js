let database;
export async function db() {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open("anynote.capture", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("capture.tasks", { keyPath: "id" });
        request.result.createObjectStore("capture.assets");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return database;
}
async function access(store, mode, action) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, mode),
      request = action(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error || Error("存储操作中断"));
  });
}
export const saveTask = (task) =>
  access("capture.tasks", "readwrite", (store) => store.put(task));
export const tasks = () =>
  access("capture.tasks", "readonly", (store) => store.getAll());
export const readAsset = (path) =>
  access("capture.assets", "readonly", (store) => store.get(path));
export const saveAsset = (path, blob) =>
  access("capture.assets", "readwrite", (store) => store.put(blob, path));

/** Remove only assets that no remaining draft references, in the same IDB transaction. */
export async function deleteTask(id) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(
        ["capture.tasks", "capture.assets"],
        "readwrite",
      ),
      tasks = tx.objectStore("capture.tasks"),
      assets = tx.objectStore("capture.assets");
    tasks.delete(id);
    const remaining = tasks.getAll();
    remaining.onsuccess = () => {
      const keep = new Set(
        remaining.result.flatMap((task) =>
          task.media.filter((m) => m.asset).map((m) => m.asset.path),
        ),
      );
      const cursor = assets.openKeyCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        if (!keep.has(item.key)) assets.delete(item.key);
        item.continue();
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
