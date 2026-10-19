const DB_NAME = "visitCommentLog";
const DB_VERSION = 4;
const STORE = "records";
const COMMENT_STORE = "comments";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("byDate", "date");
        store.createIndex("byUrl", "url");
        store.createIndex("byCreatedAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(COMMENT_STORE)) {
        const comments = db.createObjectStore(COMMENT_STORE, { keyPath: "recordKey" });
        comments.createIndex("byVideoId", "videoId");
        comments.createIndex("byCommentId", "commentId");
        comments.createIndex("byCreatedAt", "createdAt");
      }
      if (typeof upgradeHashStores === "function") upgradeHashStores(db);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function commentKey(videoId, commentId) {
  return `${videoId}|${commentId}`;
}

async function addCommentOnce(row) {
  const recordKey = commentKey(row.videoId, row.commentId);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COMMENT_STORE, "readwrite");
    const store = tx.objectStore(COMMENT_STORE);
    const getReq = store.get(recordKey);
    getReq.onsuccess = () => {
      if (getReq.result) {
        resolve(false);
        return;
      }
      const countReq = store.index("byVideoId").count(row.videoId);
      countReq.onsuccess = () => {
        store.add({
          recordKey,
          videoId: row.videoId,
          commentId: row.commentId,
          author: row.author || "",
          handle: row.handle || "",
          channelId: row.channelId || "",
          publishedTime: row.publishedTime || "",
          text: row.text || "",
          sourceUrl: row.sourceUrl || "",
          localIndex: (countReq.result || 0) + 1,
          createdAt: Date.now()
        });
      };
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => {
      if (tx.error && /constraint/i.test(String(tx.error))) resolve(false);
      else reject(tx.error);
    };
  });
}

async function getCommentsByVideo(videoId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COMMENT_STORE, "readonly");
    const idx = tx.objectStore(COMMENT_STORE).index("byVideoId");
    const req = idx.getAll(videoId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function commentCounts() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(COMMENT_STORE, "readonly").objectStore(COMMENT_STORE).getAll();
    req.onsuccess = () => {
      const map = {};
      for (const c of req.result || []) {
        map[c.videoId] = (map[c.videoId] || 0) + 1;
      }
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

