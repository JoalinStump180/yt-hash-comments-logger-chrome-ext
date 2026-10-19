document.getElementById("openExplorer")?.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("explorer.html") });
});

const commentsBox = document.getElementById("commentsLogging");
const commentsLabel = document.getElementById("commentsLoggingLabel");
function paintCommentsToggle(on) {
  commentsBox.checked = !!on;
  commentsLabel.textContent = on ? "on" : "off";
}
chrome.storage.local.get({ commentsLogging: false }).then((bag) => paintCommentsToggle(bag.commentsLogging));
commentsBox.addEventListener("change", () => {
  const on = commentsBox.checked;
  chrome.storage.local.set({ commentsLogging: on });
  paintCommentsToggle(on);
});

const overlayBox = document.getElementById("showCommentsOverlay");
chrome.storage.local.get({ showCommentsOverlay: true }).then((bag) => {
  overlayBox.checked = !!bag.showCommentsOverlay;
});
overlayBox.addEventListener("change", () => {
  chrome.storage.local.set({ showCommentsOverlay: overlayBox.checked });
});

const hashOverlayBox = document.getElementById("showHashOverlay");
chrome.storage.local.get({ showHashOverlay: false }).then((bag) => {
  hashOverlayBox.checked = !!bag.showHashOverlay;
});
hashOverlayBox.addEventListener("change", () => {
  chrome.storage.local.set({ showHashOverlay: hashOverlayBox.checked });
});

const hashBox = document.getElementById("logHash");
const hashLabel = document.getElementById("logHashLabel");
function paintHashToggle(on) {
  hashBox.checked = !!on;
  hashLabel.textContent = on ? "on" : "off";
}
chrome.storage.local.get({ logHash: false }).then((bag) => paintHashToggle(bag.logHash));
hashBox.addEventListener("change", () => {
  const on = hashBox.checked;
  chrome.storage.local.set({ logHash: on });
  paintHashToggle(on);
});

const TITLE_KEYS = ["titleIfNewHasAt", "titleIfOldLacksAt", "titleAddNewRecord"];
chrome.storage.local.get({
  titleIfNewHasAt: false,
  titleIfOldLacksAt: false,
  titleAddNewRecord: false
}).then((bag) => {
  for (const k of TITLE_KEYS) document.getElementById(k).checked = !!bag[k];
});
for (const k of TITLE_KEYS) {
  document.getElementById(k).addEventListener("change", () => {
    chrome.storage.local.set({ [k]: document.getElementById(k).checked });
  });
}

(async () => {
  const stats = document.getElementById("stats");
  try {
    const db = await openDb();
    const take = (name) => new Promise((resolve) => {
      try {
        const req = db.transaction(name, "readonly").objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });
    const records = await take(STORE);
    const comments = await take(COMMENT_STORE);
    const bytes = new Blob([JSON.stringify(records), JSON.stringify(comments)]).size;
    let count = 0;
    try {
      if (chrome.storage.session) {
        const s = await chrome.storage.session.get({ syncCacheCount: 0 });
        count = s.syncCacheCount || 0;
      }
    } catch (_) {}
    if (!count) {
      const s = await chrome.storage.local.get({ syncCacheCount: 0 });
      count = s.syncCacheCount || 0;
    }
    const kb = bytes / 1024;
    const size = kb >= 1024 ? (kb / 1024).toFixed(2) + " MB" : kb.toFixed(1) + " KB";
    stats.textContent = "IDB ~ " + size + " (" + records.length + " visits, " + comments.length + " comments) · syncCache this session: " + count;
  } catch (e) {
    stats.textContent = "IDB size n/a · " + e;
  }
})();

(async () => {
  const box = document.getElementById("list");
  try {
    let rows = [];
    try {
      const db = await openDb();
      rows = await new Promise((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
        req.onerror = () => reject(req.error);
      });
    } catch (_) {}
    if (!rows.length) {
      const bag = await chrome.storage.local.get("recordsCache");
      rows = Array.isArray(bag.recordsCache) ? bag.recordsCache : [];
    }
    if (!rows.length) {
      box.textContent = "No URLs yet. Browse in this profile after loading the extension.";
      return;
    }
    box.innerHTML = rows.slice(0, 40).map((r) =>
      `<div class="row"><div class="meta">${r.date} ${r.time}</div><b>${r.title || "(no title)"}</b><br>${r.url}</div>`
    ).join("");
  } catch (err) {
    box.textContent = "DB error: " + err;
  }
})();
