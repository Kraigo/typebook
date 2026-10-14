// Minimal IndexedDB wrapper. Book text and metadata are stored separately
// so the library list doesn't load whole books.

export interface BookMeta {
  id: string;
  title: string;
  length: number;
  pos: number; // progress as index into the normalized source text
  addedAt: number;
  openedAt: number;
}

const DB_NAME = "typebook";
let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("meta", { keyPath: "id" });
        db.createObjectStore("text");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: "meta" | "text", mode: IDBTransactionMode) {
  return (await open()).transaction(name, mode).objectStore(name);
}

export async function listBooks(): Promise<BookMeta[]> {
  const all = await wrap((await store("meta", "readonly")).getAll() as IDBRequest<BookMeta[]>);
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

export async function getMeta(id: string): Promise<BookMeta | undefined> {
  return wrap((await store("meta", "readonly")).get(id));
}

export async function getText(id: string): Promise<string | undefined> {
  return wrap((await store("text", "readonly")).get(id));
}

export async function addBook(title: string, text: string): Promise<BookMeta> {
  const now = Date.now();
  const meta: BookMeta = {
    id: crypto.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`,
    title,
    length: text.length,
    pos: 0,
    addedAt: now,
    openedAt: now,
  };
  await wrap((await store("text", "readwrite")).put(text, meta.id));
  await wrap((await store("meta", "readwrite")).put(meta));
  return meta;
}

export async function saveMeta(meta: BookMeta): Promise<void> {
  await wrap((await store("meta", "readwrite")).put(meta));
}

export async function deleteBook(id: string): Promise<void> {
  await wrap((await store("meta", "readwrite")).delete(id));
  await wrap((await store("text", "readwrite")).delete(id));
}
