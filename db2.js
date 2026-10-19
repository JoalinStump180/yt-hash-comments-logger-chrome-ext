const HASH_TEXT_STORE = "hashTexts";
const HASH_PAGE_STORE = "hashPages";
const HASH_RECYCLE_STORE = "hashRecycle";

function upgradeHashStores(db) {
  if (!db.objectStoreNames.contains(HASH_TEXT_STORE)) {
    const texts = db.createObjectStore(HASH_TEXT_STORE, { keyPath: "hashKey" });
    texts.createIndex("byPageId", "pageId");
    texts.createIndex("byCreatedAt", "createdAt");
  }
  if (!db.objectStoreNames.contains(HASH_PAGE_STORE)) {
    db.createObjectStore(HASH_PAGE_STORE, { keyPath: "pageId" });
  }
  if (!db.objectStoreNames.contains(HASH_RECYCLE_STORE)) {
    db.createObjectStore(HASH_RECYCLE_STORE, { keyPath: "recycleKey" });
  }
}

function textHash(s) {
  let h = 5381;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function hashKeyOf(author, payload) {
  return String(author || "") + "|" + textHash(payload);
}

async function addHashOnce(row) {
  const author = String(row.author || "").trim();
  const text = String(row.text || "").trim();
  const pageId = String(row.pageId || "").trim();
  if (!text || !pageId) return false;
  const hashKey = row.hashKey || hashKeyOf(author, text);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([HASH_TEXT_STORE, HASH_PAGE_STORE], "readwrite");
    const texts = tx.objectStore(HASH_TEXT_STORE);
    const pages = tx.objectStore(HASH_PAGE_STORE);
    const getReq = texts.get(hashKey);
    getReq.onsuccess = () => {
      const existed = !!getReq.result;
      if (!existed) {
        texts.add({
          hashKey,
          author,
          text,
          pageId,
          selector: row.selector || "",
          sourceUrl: row.sourceUrl || "",
          createdAt: Date.now()
        });
      }
      const pageReq = pages.get(pageId);
      pageReq.onsuccess = () => {
        const cur = pageReq.result || { pageId, hashes: [] };
        if (!cur.hashes.includes(hashKey)) cur.hashes.push(hashKey);
        pages.put(cur);
      };
    };
    tx.oncomplete = () => resolve(!getReq.result);
    tx.onerror = () => {
      if (tx.error && /constraint/i.test(String(tx.error))) resolve(false);
      else reject(tx.error);
    };
  });
}

async function deleteHash(hashKey) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([HASH_TEXT_STORE, HASH_PAGE_STORE], "readwrite");
    const texts = tx.objectStore(HASH_TEXT_STORE);
    const pages = tx.objectStore(HASH_PAGE_STORE);
    const getReq = texts.get(hashKey);
    getReq.onsuccess = () => {
      const row = getReq.result;
      texts.delete(hashKey);
      if (!row || !row.pageId) return;
      const pageReq = pages.get(row.pageId);
      pageReq.onsuccess = () => {
        const cur = pageReq.result;
        if (!cur) return;
        cur.hashes = (cur.hashes || []).filter((h) => h !== hashKey);
        pages.put(cur);
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function recycleHashItem(pageId, hashKey) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([HASH_TEXT_STORE, HASH_PAGE_STORE, HASH_RECYCLE_STORE], "readwrite");
    const texts = tx.objectStore(HASH_TEXT_STORE);
    const pages = tx.objectStore(HASH_PAGE_STORE);
    const bin = tx.objectStore(HASH_RECYCLE_STORE);
    const textReq = texts.get(hashKey);
    textReq.onsuccess = () => {
      const row = textReq.result || { hashKey, text: "", author: "" };
      const recycleKey = "r|" + Date.now() + "|" + hashKey;
      bin.add({
        recycleKey,
        originalKey: hashKey,
        pageId,
        author: row.author || "",
        text: row.text || "",
        sourceUrl: row.sourceUrl || "",
        recycledAt: Date.now()
      });
      const pageReq = pages.get(pageId);
      pageReq.onsuccess = () => {
        const cur = pageReq.result;
        if (!cur) return;
        cur.hashes = (cur.hashes || []).filter((h) => h !== hashKey);
        pages.put(cur);
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function recoverHashItem(recycleKey, overwrite) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([HASH_TEXT_STORE, HASH_PAGE_STORE, HASH_RECYCLE_STORE], "readwrite");
    const texts = tx.objectStore(HASH_TEXT_STORE);
    const pages = tx.objectStore(HASH_PAGE_STORE);
    const bin = tx.objectStore(HASH_RECYCLE_STORE);
    const recReq = bin.get(recycleKey);
    recReq.onsuccess = () => {
      const rec = recReq.result;
      if (!rec) return;
      const existReq = texts.get(rec.originalKey);
      existReq.onsuccess = () => {
        const existing = existReq.result;
        if (existing && existing.text && !overwrite) {
          resolve("needs-overwrite");
          return;
        }
        texts.put({
          hashKey: rec.originalKey,
          author: rec.author || "",
          text: rec.text || "",
          pageId: rec.pageId || "",
          sourceUrl: rec.sourceUrl || "",
          createdAt: existing ? existing.createdAt : Date.now()
        });
        const pageReq = pages.get(rec.pageId);
        pageReq.onsuccess = () => {
          const cur = pageReq.result || { pageId: rec.pageId, hashes: [] };
          if (!cur.hashes.includes(rec.originalKey)) cur.hashes.push(rec.originalKey);
          pages.put(cur);
        };
        bin.delete(recycleKey);
        resolve("recovered");
      };
    };
    tx.oncomplete = () => {};
    tx.onerror = () => reject(tx.error);
  });
}
