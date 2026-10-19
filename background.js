importScripts("db.js", "db2.js");



function pad(n) {
  return String(n).padStart(2, "0");
}

function todayStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}$$`;
}

function nowParts(d = new Date()) {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  };
}

function youtubeVideoId(urlObj) {
  const host = urlObj.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    return urlObj.pathname.split("/").filter(Boolean)[0] || "";
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (urlObj.searchParams.get("v")) return urlObj.searchParams.get("v");
    const parts = urlObj.pathname.split("/").filter(Boolean);
    if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live" || parts[0] === "post") {
      return parts[1] || "";
    }
  }
  return "";
}

function canonicalize(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") return "";

  const vid = youtubeVideoId(u);
  if (vid) {
    const existing = u.searchParams.get("todaydate");
    const todaydate = existing && existing.length ? existing : todayStamp();

    if (u.pathname.startsWith("/post/")) {
      return `https://www.youtube.com/post/${vid}?todaydate=${todaydate}`;
    }
    return `https://www.youtube.com/watch?v=${vid}&todaydate=${todaydate}`;
  }

  u.hash = "";
  return u.origin + u.pathname + u.search;
}

function shouldIgnore(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://microsoftedge.microsoft.com/")
  );
}

async function getAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function findByUrl(url) {
  const all = await getAll();
  const hits = all.filter((r) => r.url === url);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return hits[0];
}

function titleHasAt(t) {
  return String(t || "").includes("@");
}

async function titlePolicy() {
  const bag = await chrome.storage.local.get({
    titleIfNewHasAt: false,
    titleIfOldLacksAt: false,
    titleAddNewRecord: false
  });
  return bag;
}

function policyWantsUpdate(oldTitle, newTitle, flags) {
  if (!newTitle) return false;
  if (flags.titleIfNewHasAt && titleHasAt(newTitle)) return true;
  if (flags.titleIfOldLacksAt && !titleHasAt(oldTitle) && titleHasAt(newTitle)) return true;
  return false;
}

async function getTabTitle(tabId) {
  if (tabId == null) return "";
  try {
    const tab = await chrome.tabs.get(tabId);
    return String(tab.title || "").trim();
  } catch {
    return "";
  }
}

function waitForTitle(tabId, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(await getTabTitle(tabId));
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.title) finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(finish, timeoutMs);
  });
}

async function resolveTitle(tabId) {
  let title = await getTabTitle(tabId);
  if (!title || title === "YouTube" || title === "Loading...") {
    title = await waitForTitle(tabId);
  }
  return title;
}

async function putRecord(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    if (record.id != null) tx.objectStore(STORE).put(record);
    else tx.objectStore(STORE).add(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function bumpSyncCacheCount() {
  try {
    if (chrome.storage.session) {
      const bag = await chrome.storage.session.get({ syncCacheCount: 0 });
      await chrome.storage.session.set({ syncCacheCount: (bag.syncCacheCount || 0) + 1 });
      return;
    }
  } catch (_) {}
  const bag = await chrome.storage.local.get({ syncCacheCount: 0 });
  await chrome.storage.local.set({ syncCacheCount: (bag.syncCacheCount || 0) + 1 });
}

async function syncCache() {
  try {
    const all = await getAll();
    await chrome.storage.local.set({ recordsCache: all });
    await bumpSyncCacheCount();
  } catch (err) {
    console.error("[visit-url-logger] cache", err);
  }
}

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ syncCacheCount: 0 });
  chrome.storage.session?.set({ syncCacheCount: 0 });
});

 

// 1. Core synchronous-style DB write (returns immediately without awaiting UI or network)
async function logUrlImmediately(rawUrl) {
  if (!rawUrl || shouldIgnore(rawUrl)) return;
  //const key = canonicalize(rawUrl);
  const key = rawUrl;
  if (!key) return;

  const { date, time } = nowParts();
  
  // Write the URL record right away with a fallback title
  // (e.g. key/hostname) so rapid cancels are NEVER lost.
  await putRecord({
    date,
    time,
    url: key,
    title: key, // Fallback title until/if updated later
    comments: "",
    createdAt: Date.now()
  });
  
//  await syncCache();
  console.log("[visit-url-logger] Instant logged:", key);
}

// 2. Listen to onBeforeNavigate / onCommitted directly
// This fires at 0.0s the instant you click the favorite bar button
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return; // Only log top-level tab navigations
  logUrlImmediately(""+details.url+"     by Navigation.onBeforeNavigate").catch(console.error);
});

// Optional: Keep onCommitted as a backup for same-document/history state changes
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  // If it's a history API pushState/replaceState transition
  if (details.transitionQualifiers.includes("client_redirect") || details.transitionType === "link") {
    logUrlImmediately(""+details.url).catch(console.error);
  }
});

// 3. Asynchronously update the title LATER if the page actually finishes loading
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  
  const key = canonicalize(details.url);
  if (!key || shouldIgnore(key)) return;

  const title = await resolveTitle(details.tabId);
  if (!title) return;

  // Find the record created on beforeNavigate and update its title
//  const db = await openDb();
  //const tx = db.transaction(STORE, "readwrite");
 // const store = tx.objectStore(STORE);
  
  //const all = await getAll();
 // const existing = all
   // .filter(r => r.url === key)
  //  .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

  //if (existing) {
   // existing.title = ""+title;
    //await putRecord(existing);
    const { date, time } = nowParts();
          await putRecord({
        date:  date,
        time:   time,
        url: key||"",
        title: title+"     by  Navigation.onComplete",
        comments: "Captured via link click",
        createdAt: Date.now()
      });
    
    
   // await syncCache();
    //console.log("[visit-url-logger] Updated title for:", key, "->", title);
  //}
});










var lasttitle = "lasttitle"
var lasturl = "lasturl"
async function addUrl(url, title) {
  if (!url) return false;
  //const flags = await titlePolicy();
  //const existing = await findByUrl(url);
  //const existing = 1
  
 
   // if (title && title !== lasttitle && policyWantsUpdate(lasttitle, title, flags)) {
    if (title && title !== lasttitle  ) {
     // if (flags.titleAddNewRecord) {
      if (1) {
        //const all = await getAll();
        //const dup = all.some((r) => r.url === url && r.title === title);
        //if (dup) return false;
        const { date, time } = nowParts();
        await putRecord({ date, time, url, title, comments: "", createdAt: Date.now() });
        //await syncCache();
      lasttitle = title;
       
        return false;
      }
      //await putRecord(existing);
      //await syncCache();
    }
    
    
        if ( url&& url !== lasturl  ) {
     // if (flags.titleAddNewRecord) {
      if (1) {
        //const all = await getAll();
        //const dup = all.some((r) => r.url === url && r.title === title);
        //if (dup) return false;
        const { date, time } = nowParts();
        await putRecord({ date, time, url, title, comments: "", createdAt: Date.now() });
        //await syncCache();
       
      lasturl = url;
        return false;
      }
      //await putRecord(existing);
      //await syncCache();
    }
    
    
 
  //const { date, time } = nowParts();
  //await putRecord({
    //date,
    //time,
    //url,
    //title: title || "",
    //comments: "",
    //createdAt: Date.now()
  //});
  //await syncCache();
  return true;
}

 

//syncCache().catch(console.error);




chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'logCustomHistory') {
    // Pass this directly into your FIFO queue / putRecord function!
    console.log('[Background Received]:', message.url, message.title);
    alert(`[from background.js: ]\nURL: ${message.url}\nTitle: ${message.title}`);
   
    queueManager.enqueue(async () => {
      await putRecord({
        date: message.date,
        time: message.time,
        url: message.url,
        title: message.title,
        comments: "Captured via link click",
        createdAt: Date.now()
      });
      
      // Sync cache if needed
     // await syncCache();
    });
  }
});





chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "get-records") {
    (async () => {
      let rows = [];
      try { rows = await getAll(); } catch (_) {}
      if (!rows.length) {
        const bag = await chrome.storage.local.get("recordsCache");
        rows = Array.isArray(bag.recordsCache) ? bag.recordsCache : [];
      }
      sendResponse({ rows });
    })();
    return true;
  }
  
  
  if (msg && msg.type === "page-title2") {
  (async () => {
    //const url = canonicalize(msg.url || "");
    const url = msg.url || "";
    const title = String(msg.title || "");

    console.log("[Background] page-title2 received:", url, title);

    if (!url || shouldIgnore(url)) {
      sendResponse({ ok: false, error: "Invalid or ignored URL" });
      return;
    }

    const { date, time } = nowParts();

    await putRecord({
      date: msg.date || date,
      time: msg.time || time,
      url,
      title: title || url,
      comments: "Custom page-title2 event",
      createdAt: Date.now()
    });

    //await syncCache();

    console.log("[Background] Saved successfully:", url);
    sendResponse({ ok: true, url });
  })().catch(error => {
    console.error("[Background] Save failed:", error);
    sendResponse({ ok: false, error: String(error) });
  });

  return true;
}
  
  
  
  
  
  if (msg && msg.type === "page-title") {
    const key = canonicalize(msg.url || "");
    const title = String(msg.title || "");
    
    //jcx
    console.log('[ in  background.js  page-title Received]:', key,  title);
    //alert(`[in  background.js ]\nURL: ${key}\nTitle: ${title}`);
    //jcx
    if (key && title) addUrl(key, title).catch(console.error);
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "yt-comments" && Array.isArray(msg.batch)) {
    (async () => {
      const bag = await chrome.storage.local.get({ commentsLogging: false });
      if (!bag.commentsLogging) {
        sendResponse({ saved: 0, off: true });
        return;
      }
      let saved = 0;
      for (const row of msg.batch) {
        if (!row.videoId || !row.commentId) continue;
        if (await addCommentOnce(row)) saved += 1;
      }
      try {
        const db = await openDb();
        const all = await new Promise((resolve, reject) => {
          const req = db.transaction(COMMENT_STORE, "readonly").objectStore(COMMENT_STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
        await chrome.storage.local.set({ commentsCache: all });
      } catch (_) {}
      sendResponse({ saved });
    })().catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (msg && msg.type === "yt-hash" && Array.isArray(msg.batch)) {
    (async () => {
      const bag = await chrome.storage.local.get({ logHash: false });
      if (!bag.logHash) {
        sendResponse({ saved: 0, off: true, results: [] });
        return;
      }
      const db = await openDb();
      const history = await new Promise((resolve) => {
        try {
          const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } catch (_) { resolve([]); }
      });
      const titleFor = (pageId, sourceUrl) => {
        const hits = history.filter((r) => r && r.url && (String(r.url).includes(pageId) || r.url === sourceUrl));
        hits.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const titled = hits.find((r) => r.title && !/youtube|loading/i.test(r.title));
        return {
          title: titled ? titled.title : (hits[0] && hits[0].title) || "",
          url: (titled && titled.url) || (hits[0] && hits[0].url) || sourceUrl || ""
        };
      };
      let saved = 0;
      const results = [];
      for (const row of msg.batch) {
        const existing = await new Promise((resolve) => {
          try {
            const req = db.transaction(HASH_TEXT_STORE, "readonly").objectStore(HASH_TEXT_STORE).get(row.hashKey);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
          } catch (_) { resolve(null); }
        });
        const isNew = await addHashOnce(row);
        if (isNew) saved += 1;
        const meta = titleFor(row.pageId, row.sourceUrl);
        results.push({
          hashKey: row.hashKey,
          author: row.author || "",
          isNew: !!isNew,
          createdAt: existing ? existing.createdAt : Date.now(),
          title: meta.title,
          url: meta.url,
          text: row.text || ""
        });
      }
      sendResponse({ saved, results });
    })().catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
});
 