const $ = (id) => document.getElementById(id);
    let rows = [];
    let filter = "all";
    let selectedId = null;

    function pad(n) { return String(n).padStart(2, "0"); }
    function setNow() {
      const d = new Date();
      $("date").value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      $("time").value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    let includeComments = false;
    let expandCommentsOnUrlHit = false;
    let dedupeCommentId = false;
    let dedupeTitleDaily = false;
    const firstRowByCommentId = new Map();
    const openVideos = new Set();
    // Explicit user folds override automatic expansion caused by comment search hits.
    const foldedVideos = new Set();
    let lastFoldQuery = null;
    const commentsByVideo = new Map();
    const recycledByVideo = new Map();
    const selectedComments = new Set();
    const selectedRows = new Set();
    
    
function videoIdFromStoredUrl(url) {
  const s = String(url || "");

  // watch?v=ID or &v=ID, id is 11 chars but accept the usual safe set
  const v = s.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  if (v) return v[1];

  // youtu.be/ID
  const short = s.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (short) return short[1];

  // /post/ID /shorts/ID /embed/ID /live/ID
  const path = s.match(/\/(?:post|shorts|embed|live)\/([A-Za-z0-9_-]{6,})/);
  if (path) return path[1];

  return "";
}
function videoIdFromStoredUrl2(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "post" || parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") {
      return parts[1] || "";
    }
    return "";
  } catch {
    return "";
  }
}

    async function withStore(mode, fn) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const result = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
      });
    }

    function normUrl(u) {
      return String(u || "").trim().replace(/\/+$/, "").toLowerCase();
    }
    function normComment(c) {
      return String(c || "").trim().replace(/\s+/g, " ");
    }
    async function pairExists(url, comments) {
      const u = normUrl(url);
      const c = normComment(comments);
      const all = await getAll();
      return all.some((r) => normUrl(r.url) === u && normComment(r.comments) === c);
    }
    async function addRecord(record) {
      if (await pairExists(record.url, record.comments)) return false;
      await withStore("readwrite", (store) => store.add(record));
      return true;
    }
    async function deleteRecord(id) {
      return withStore("readwrite", (store) => store.delete(id));
    }
    // Fast path for startup: fetch only the newest records from IndexedDB.
    // The full getAll() path below remains available for complete search and legacy fallbacks.
    async function getRecent(limit = PAGE) {
      try {
        const db = await openDb();
        const recent = await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const store = tx.objectStore(STORE);
          let source = store;
          try {
            if (store.indexNames.contains("byCreatedAt")) source = store.index("byCreatedAt");
          } catch (_) {}
          const req = source.openCursor(null, "prev");
          const out = [];
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor || out.length >= limit) {
              resolve(out);
              return;
            }
            out.push(cursor.value);
            cursor.continue();
          };
          req.onerror = () => reject(req.error);
          tx.onerror = () => reject(tx.error);
        });
        if (recent.length >= limit) return recent.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      } catch (_) {}

      // Fallback for old databases, storage-cache-only installs, or an empty index.
      const all = await getAll();
      return all.slice(0, limit);
    }

    async function getAll() {
      try {
        const db = await openDb();
        const fromIdb = await new Promise((resolve, reject) => {
          const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
        if (fromIdb.length) return fromIdb.sort((a,b) => (b.createdAt||0)-(a.createdAt||0));
      } catch (_) {}
      try {
        const bag = await chrome.storage.local.get("recordsCache");
        if (Array.isArray(bag.recordsCache) && bag.recordsCache.length) {
          return bag.recordsCache.sort((a,b) => (b.createdAt||0)-(a.createdAt||0));
        }
      } catch (_) {}
      try {
        const res = await chrome.runtime.sendMessage({ type: "get-records" });
        return Array.isArray(res?.rows) ? res.rows : [];
      } catch (_) {
        return [];
      }
    }

    const PAGE = 80;
    const SEEK_CHUNK = 800;
    let matched = [];
    let shown = 0;
    let seekToken = 0;

    function setSeek(pct, label) {
      $("seek").textContent = label || ("Seek " + pct + "%");
    }

    // Split the search box into tokens. Quoted phrases stay together.
    // A leading hyphen marks an exclusion: -dog or -"a big dog".
    function parseQuery(q) {
      const s = String(q || "").trim();
      if (!s) return [];
      const tokens = [];
      const re = /(-?)"([^"]*)"|(\S+)/g;
      let m;
      while ((m = re.exec(s))) {
        let negative;
        let text;
        if (m[2] != null) {
          negative = m[1] === "-";
          text = m[2].trim();
        } else {
          const raw = m[3];
          negative = raw.startsWith("-") && raw.length > 1;
          text = (negative ? raw.slice(1) : raw).trim();
        }
        text = text.toLowerCase();
        if (text) tokens.push({ text, negative });
      }
      return tokens;
    }
    // Positive tokens use AND; any matching negative token excludes the item.
    // A query containing only negative tokens is valid and matches items that
    // contain none of the excluded substrings.
    function hayHasAll(hay, tokens) {
      if (!tokens.length) return true;
      const h = String(hay || "").toLowerCase();
      if (tokens.some((t) => t.negative && h.includes(t.text))) return false;
      return tokens.filter((t) => !t.negative).every((t) => h.includes(t.text));
    }
    // Search-range switches: datetime is opt-in; URL and title are opt-out.
    let searchInDateTime = false;
    let searchInUrl = true;
    let searchInTitle = true;

    function historyDateTimeHay(r) {
      return [r.date, r.time].filter(Boolean).join(" ");
    }
    // History notes/comments remain searchable; the three switches gate only
    // their corresponding fields, not the visible columns or filtering sidebar.
    function pageHay(r) {
      return [
        searchInDateTime ? historyDateTimeHay(r) : "",
        searchInTitle ? r.title : "",
        searchInUrl ? r.url : "",
        r.comments,
        String(r.id)
      ].join(" ");
    }
    function videoRowForId(videoId, preferredRow) {
      if (preferredRow && videoIdFromStoredUrl(preferredRow.url) === videoId) return preferredRow;
      return rows.find((r) => videoIdFromStoredUrl(r.url) === videoId) || null;
    }
    function commentDateTimeHay(c) {
      let created = "";
      if (typeof c.createdAt === "number" && Number.isFinite(c.createdAt)) {
        created = new Date(c.createdAt).toLocaleString();
      } else if (c.createdAt) {
        created = String(c.createdAt);
      }
      return [c.publishedTime, created].filter(Boolean).join(" ");
    }
    // URL/title metadata belongs to the video, so it is searchable from each
    // associated comment as well as from the history row itself.
    function commentHay(c, preferredRow) {
      const videoId = String(c.videoId || "");
      const videoRow = videoRowForId(videoId, preferredRow);
      const videoUrl = videoRow ? videoRow.url : (videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : "");
      return [
        c.commentId, c.text, c.author, c.handle, c.channelId, String(c.localIndex),
        searchInDateTime ? commentDateTimeHay(c) : "",
        searchInUrl ? [videoUrl, c.sourceUrl].join(" ") : "",
        searchInTitle && videoRow ? videoRow.title : ""
      ].join(" ");
    }
    function pageHits(r, q) {
      return hayHasAll(pageHay(r), parseQuery(q));
    }
    function commentHits(list, q, preferredRow) {
      const tokens = parseQuery(q);
      return (list || []).filter((c) => hayHasAll(commentHay(c, preferredRow), tokens));
    }
    function commentHitsAny(list, q, preferredRow) {
      const tokens = parseQuery(q);
      if (!tokens.length) return [];
      const positive = tokens.filter((t) => !t.negative);
      const negative = tokens.filter((t) => t.negative);
      return (list || []).filter((c) => {
        const h = commentHay(c, preferredRow).toLowerCase();
        if (negative.some((t) => h.includes(t.text))) return false;
        // For negative-only searches, all comments that pass the exclusions
        // are valid hits. Otherwise this helper finds partial positive hits.
        return positive.length === 0 || positive.some((t) => h.includes(t.text));
      });
    }
    // Fields that belong to the comment itself, excluding video URL/title metadata.
    // This distinction lets the URL-hit checkbox decide whether a URL match alone
    // should expose every comment, rather than making every comment look like a hit.
    function commentOwnHay(c) {
      return [c.commentId, c.text, c.author, c.handle, c.channelId, String(c.localIndex),
        searchInDateTime ? commentDateTimeHay(c) : "", c.sourceUrl].join(" ");
    }
    function commentOwnHitsAny(list, q) {
      const tokens = parseQuery(q);
      if (!tokens.length) return [];
      const positive = tokens.filter(t => !t.negative);
      const negative = tokens.filter(t => t.negative);
      return (list || []).filter(c => {
        const h = commentOwnHay(c).toLowerCase();
        if (negative.some(t => h.includes(t.text))) return false;
        return positive.length === 0 || positive.some(t => h.includes(t.text));
      });
    }
    function matchRow(r, q) {
      const url = (r.url || "").toLowerCase();
      if (filter === "yt" && !url.includes("youtube.com") && !url.includes("youtu.be")) return false;
      if (filter === "other" && (url.includes("youtube.com") || url.includes("youtu.be"))) return false;
      if (filter === "recycle") {
        const vid = videoIdFromStoredUrl(r.url);
        if (!(recycledByVideo.get(vid) || []).length) return false;
      }
      if (!q) return true;
      if (pageHits(r, q)) return true;
      if (!includeComments) return false;
      const vid = videoIdFromStoredUrl(r.url);
      const list = activeComments(vid);
      if (commentHits(list, q, r).length) return true;
      return hayHasAll(pageHay(r) + " " + list.map((c) => commentHay(c, r)).join(" "), parseQuery(q));
    }

    function activeComments(vid) {
      return filter === "recycle" ? (recycledByVideo.get(vid) || []) : (commentsByVideo.get(vid) || []);
    }
    function commentBlock(list, q = "") {
      if (!list.length) return `<div class="cmt">No comments logged for this video.</div>`;
      return list.map((c) =>
        `<div class="cmt ${selectedComments.has(c.recordKey) ? "sel" : ""}" data-key="${esc(c.recordKey)}"><span class="uid">#${highlightSearchText(c.localIndex ?? "?", q)}  ${highlightSearchText(c.handle || (c.author ? "@" + c.author : ""), q)}  ${highlightSearchText(c.channelId || "", q)}  ${highlightSearchText(c.publishedTime || "", q)}  ${highlightSearchText(c.commentId || "", q)}</span>\n${highlightSearchText(c.text || "", q)}</div>`
      ).join("");
    }

    function onlyFirstRow(list, rowId) {
      if (!dedupeCommentId) return list;
      return (list || []).filter((c) => firstRowByCommentId.get(c.commentId || c.recordKey) === rowId);
    }
    function rebuildFirstRowMap() {
      firstRowByCommentId.clear();
      if (!dedupeCommentId) return;
      for (const r of matched) {
        const list = activeComments(videoIdFromStoredUrl(r.url));
        for (const c of list) {
          const k = c.commentId || c.recordKey;
          if (k && !firstRowByCommentId.has(k)) firstRowByCommentId.set(k, r.id);
        }
      }
    }

    // Keep only the newest row for each canonicalized non-empty title on each date.
    // Canonicalization removes every "time" + 6-digit field (e.g. time123456).
    // This only changes the displayed/matched list; stored history rows are untouched.
    function onlyNewestTitlePerDay(list) {
      if (!dedupeTitleDaily) return list;
      const winnerByKey = new Map();
      const dateTimeValue = (r) => {
        const value = Date.parse(`${String(r.date || "").trim()}T${String(r.time || "00:00").trim()}`);
        return Number.isFinite(value) ? value : -Infinity;
      };
      const canonicalTitle = (r) => String(r.title || "").trim().replace(/time[0-9]{6}/gi, "").trim();
      const isNewer = (candidate, current) => {
        const a = dateTimeValue(candidate);
        const b = dateTimeValue(current);
        if (a !== b) return a > b;
        return Number(candidate.id) > Number(current.id);
      };
      for (const r of list || []) {
        const originalTitle = String(r.title || "").trim();
        // Truly empty titles are common for manually-created rows; don't collapse them.
        if (!originalTitle) continue;
        const title = canonicalTitle(r);
        const key = JSON.stringify([String(r.date || ""), title]);
        const current = winnerByKey.get(key);
        if (!current || isNewer(r, current)) winnerByKey.set(key, r);
      }
      const winners = new Set(winnerByKey.values());
      return (list || []).filter((r) => {
        const originalTitle = String(r.title || "").trim();
        return !originalTitle || winners.has(r);
      });
    }

    function rowHtml(r) {
      const vid = videoIdFromStoredUrl(r.url);
      const q = $("q").value.trim().toLowerCase();
      const all = onlyFirstRow(activeComments(vid), r.id);
      const fullHits = q && includeComments ? commentHits(all, q, r) : [];
      const partHits = q && includeComments ? commentHitsAny(all, q, r) : [];
      const hits = fullHits.length ? fullHits : partHits;
      const tokens = parseQuery(q);
      const positiveTokens = tokens.filter(t => !t.negative);
      const urlHit = !!q && searchInUrl && positiveTokens.length > 0 && hayHasAll(r.url || "", tokens);
      // With the checkbox on, a URL hit OR a hit in any comment-owned field
      // (text, @handle/author, channel ID, etc.) unfolds every comment on that video.
      const commentOwnHits = q && includeComments ? commentOwnHitsAny(all, q) : [];
      const showAllForHit = expandCommentsOnUrlHit && (urlHit || commentOwnHits.length > 0);
      // URL/title metadata repeated in commentHay must not count as a comment hit
      // by itself when the expand-all checkbox is off.
      const urlOnlyHits = urlHit && !showAllForHit ? commentOwnHits : hits;
      const auto = includeComments && !!q && urlOnlyHits.length > 0;
      const show = vid && !foldedVideos.has(vid) && (openVideos.has(vid) || auto || showAllForHit || filter === "recycle");
      const fold = vid
        ? `<button class="fold" data-vid="${esc(vid)}" type="button">${show ? "?" : "+"}</button><button class="selall" data-vid="${esc(vid)}" type="button" title="Select all/none comments">?</button>`
        : "";
      const detail = show
        ? `<tr class="cmt-row" data-vid="${esc(vid)}"><td colspan="5">${commentBlock(showAllForHit ? all : (auto ? urlOnlyHits : all), q)}</td></tr>`
        : "";
      return `<tr data-id="${r.id}" class="${r.id===selectedId?"sel":""} ${selectedRows.has(r.id)?"row-sel":""}">
          <td>${esc(r.date)}</td>
          <td>${esc(r.time)}</td>
          <td title="${esc(r.title)}">${fold}${esc(r.title || "")}</td>
          <td title="${esc(r.url)}">${highlightSearchText(r.url || "", q)}</td>
          <td>${r.id}</td>
        </tr>${detail}`;
    }

    function paintPreview() {
      const cur = rows.find((x) => x.id === selectedId);
      $("preview").textContent = cur
        ? `${cur.date} ${cur.time}\n${cur.title || ""}\n${cur.url}`
        : "Select a row to preview.";
    }

    function renderSlice(reset) {
      const tb = $("tbody");
      if (reset) {
        shown = 0;
        tb.innerHTML = "";
      }
      const next = matched.slice(shown, shown + PAGE);
      if (next.length) tb.insertAdjacentHTML("beforeend", next.map(rowHtml).join(""));
      shown += next.length;
      $("empty").hidden = matched.length > 0;
      $("status").textContent = shown + " of " + matched.length + " shown";
      paintPreview();
    }

    function seek(q) {
      // A changed query gets a fresh automatic-expansion decision; a fold click
      // reruns seek with the same query and therefore keeps the user override.
      const foldQuery = String(q || "").trim().toLowerCase();
      if (lastFoldQuery !== null && foldQuery !== lastFoldQuery) foldedVideos.clear();
      lastFoldQuery = foldQuery;
      matched = rows.filter((r) => matchRow(r, q));
      matched = onlyNewestTitlePerDay(matched);
      rebuildFirstRowMap();
      setSeek(100, "Seek 100% · " + matched.length);
      renderSlice(true);
    }

    function esc(s) {
      return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
    }
    // Highlight positive search tokens in visible URL/comment text. The original
    // text is HTML-escaped before insertion, so matching text cannot inject markup.
    function highlightSearchText(value, q) {
      const source = String(value ?? "");
      const terms = [...new Set(parseQuery(q).filter(t => !t.negative).map(t => t.text).filter(Boolean))]
        .sort((a, b) => b.length - a.length);
      if (!terms.length) return esc(source);
      const re = new RegExp(terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "ig");
      let out = "", last = 0, m;
      while ((m = re.exec(source))) {
        out += esc(source.slice(last, m.index)) + '<mark class="search-hit">' + esc(m[0]) + '</mark>';
        last = m.index + m[0].length;
        if (!m[0].length) re.lastIndex++;
      }
      return out + esc(source.slice(last));
    }

    async function loadCommentsIndex() {
      commentsByVideo.clear();
      recycledByVideo.clear();
      try {
        const db = await openDb();
        const all = await new Promise((resolve, reject) => {
          const req = db.transaction(COMMENT_STORE, "readonly").objectStore(COMMENT_STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
        for (const c of all) {
          const bag = c.recycled ? recycledByVideo : commentsByVideo;
          const list = bag.get(c.videoId) || [];
          list.push(c);
          bag.set(c.videoId, list);
        }
        for (const list of [...commentsByVideo.values(), ...recycledByVideo.values()]) {
          list.sort((a, b) => (a.localIndex || a.createdAt || 0) - (b.localIndex || b.createdAt || 0));
          list.forEach((c, i) => { if (!c.localIndex) c.localIndex = i + 1; });
        }
      } catch (_) {}
      if (!commentsByVideo.size) {
        try {
          const bag = await chrome.storage.local.get("commentsCache");
          for (const c of bag.commentsCache || []) {
            const list = commentsByVideo.get(c.videoId) || [];
            list.push(c);
            commentsByVideo.set(c.videoId, list);
          }
        } catch (_) {}
      }
    }

    let loadRun = 0;
    async function loadLazy() {
      const run = ++loadRun;
      rows = [];
      matched = [];
      shown = 0;
      $("tbody").innerHTML = "";
      setSeek(0, "Loading recent history…");
      $("empty").hidden = true;
      if (!location.protocol.startsWith("chrome") && !location.protocol.startsWith("edge") && !location.protocol.startsWith("extension")) {
        $("status").textContent = "Wrong page: open explorer from the extension popup, not a file:// path.";
      }
      try {
        // Show the first screen as soon as the small newest-first query completes.
        const recent = await getRecent(PAGE);
        if (run !== loadRun) return;
        rows = recent;
        seek($("q").value.trim().toLowerCase());
        setSeek(0, "Recent rows · loading full history…");
        $("status").textContent = recent.length
          ? (shown + " of " + matched.length + " recent rows shown · loading full history…")
          : "Checking history…";

        // These potentially expensive operations no longer block the first visible rows.
        const fullLoad = getAll();
        const commentsLoad = loadCommentsIndex().catch(() => {});
        const all = await fullLoad;
        if (run !== loadRun) return;
        rows = all;
        setSeek(100, "Loaded " + rows.length);
        seek($("q").value.trim().toLowerCase());
        $("status").textContent = rows.length
          ? (shown + " of " + matched.length + " shown · loaded " + rows.length)
          : "0 items. Popup has data? Reload extension, visit a page, then click Refresh.";
        // Let comment data finish independently; don't hold up URL history display.
        void commentsLoad;
      } catch (err) {
        if (run !== loadRun) return;
        $("status").textContent = "Load error: " + err;
        $("empty").hidden = false;
        $("empty").textContent = String(err);
      }
    }

    async function refresh() {
      await loadLazy();
    }

    function visibleCommentKeys() {
      const keys = [];
      for (const tr of document.querySelectorAll("#tbody tr.cmt-row")) {
        tr.querySelectorAll(".cmt[data-key]").forEach((el) => keys.push(el.dataset.key));
      }
      return keys;
    }
    function findComment(key) {
      for (const bag of [commentsByVideo, recycledByVideo]) {
        for (const list of bag.values()) {
          const hit = list.find((c) => c.recordKey === key);
          if (hit) return hit;
        }
      }
      return null;
    }
    async function putComment(row) {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(COMMENT_STORE, "readwrite");
        tx.objectStore(COMMENT_STORE).put(row);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
    async function eraseComment(key) {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(COMMENT_STORE, "readwrite");
        tx.objectStore(COMMENT_STORE).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
    function hideMenu() { $("menu").style.display = "none"; }
    function showMenu(x, y, items) {
      const menu = $("menu");
      menu.innerHTML = items.map((it, i) => `<button type="button" data-i="${i}">${esc(it.label)}</button>`).join("");
      menu.style.left = x + "px";
      menu.style.top = y + "px";
      menu.style.display = "block";
      menu.onclick = async (ev) => {
        const btn = ev.target.closest("button");
        if (!btn) return;
        hideMenu();
        await items[Number(btn.dataset.i)].run();
      };
    }
    function selectRange() {
      const keys = visibleCommentKeys();
      const picked = keys.filter((k) => selectedComments.has(k));
      if (picked.length < 2) return;
      const a = keys.indexOf(picked[0]);
      const b = keys.indexOf(picked[picked.length - 1]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selectedComments.add(keys[i]);
      seek($("q").value.trim().toLowerCase());
    }
    async function recycleSelected() {
      for (const key of [...selectedComments]) {
        const c = findComment(key);
        if (!c || c.recycled) continue;
        c.recycled = true;
        await putComment(c);
      }
      selectedComments.clear();
      await refresh();
    }
    async function recoverSelected() {
      for (const key of [...selectedComments]) {
        const c = findComment(key);
        if (!c || !c.recycled) continue;
        c.recycled = false;
        await putComment(c);
      }
      selectedComments.clear();
      selectedRows.clear();
      await refresh();
    }
    async function purgeSelected() {
      if (!selectedComments.size) return;
      if (!confirm("Permanently delete " + selectedComments.size + " comment(s)?")) return;
      for (const key of [...selectedComments]) await eraseComment(key);
      selectedComments.clear();
      selectedRows.clear();
      await refresh();
    }

    $("tbody").addEventListener("click", (e) => {
      const selAll = e.target.closest(".selall");
      if (selAll) {
        const keys = activeComments(selAll.dataset.vid).map((c) => c.recordKey);
        const allOn = keys.length && keys.every((k) => selectedComments.has(k));
        keys.forEach((k) => allOn ? selectedComments.delete(k) : selectedComments.add(k));
        seek($("q").value.trim().toLowerCase());
        return;
      }
      const cmt = e.target.closest(".cmt[data-key]");
      if (cmt && e.ctrlKey) {
        const key = cmt.dataset.key;
        if (selectedComments.has(key)) selectedComments.delete(key);
        else selectedComments.add(key);
        cmt.classList.toggle("sel", selectedComments.has(key));
        return;
      }
      const fold = e.target.closest(".fold");
      if (fold) {
        const vid = fold.dataset.vid;
        // Inspect the current DOM before rerendering: if the detail row exists,
        // the user is closing it; otherwise they are explicitly opening it.
        const currentlyShown = !!document.querySelector(`#tbody tr.cmt-row[data-vid="${CSS.escape(vid)}"]`);
        if (currentlyShown) {
          foldedVideos.add(vid);
          openVideos.delete(vid);
        } else {
          foldedVideos.delete(vid);
          openVideos.add(vid);
        }
        seek($("q").value.trim().toLowerCase());
        return;
      }
      const tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      selectedId = Number(tr.dataset.id);
      if (filter === "recycle" && e.ctrlKey) {
        if (selectedRows.has(selectedId)) selectedRows.delete(selectedId);
        else selectedRows.add(selectedId);
      }
      document.querySelectorAll("#tbody tr").forEach((x) => x.classList.toggle("sel", Number(x.dataset.id) === selectedId));
      document.querySelectorAll("#tbody tr[data-id]").forEach((x) => x.classList.toggle("row-sel", selectedRows.has(Number(x.dataset.id))));
      paintPreview();
    });
    $("tbody").addEventListener("contextmenu", (e) => {
      const cmt = e.target.closest(".cmt[data-key]");
      const tr = e.target.closest("tr[data-id]");
      if (!cmt && !(filter === "recycle" && tr)) return;
      e.preventDefault();
      if (cmt && !selectedComments.has(cmt.dataset.key)) selectedComments.add(cmt.dataset.key);
      if (filter === "recycle") {
        showMenu(e.clientX, e.clientY, [
          { label: "Select range", run: async () => selectRange() },
          { label: "Recover", run: recoverSelected },
          { label: "Delete permanently", run: purgeSelected }
        ]);
      } else {
        showMenu(e.clientX, e.clientY, [
          { label: "Select range", run: async () => selectRange() },
          { label: "Delete selected (recycle)", run: recycleSelected }
        ]);
      }
    });
    document.addEventListener("click", (e) => { if (!e.target.closest("#menu")) hideMenu(); });

    document.querySelector(".listwrap").addEventListener("scroll", (e) => {
      const el = e.target;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
        if (shown < matched.length) renderSlice(false);
      }
    });

    const RECENT_SEARCHES_KEY = "recentSearchPatterns";
    const MAX_RECENT_SEARCHES = 40;
    const recentSearchesSelect = $("recentSearches");
    let recentSearchPatterns = [];

    function renderRecentSearches() {
      recentSearchesSelect.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = `Recent searches (${recentSearchPatterns.length}/${MAX_RECENT_SEARCHES})`;
      recentSearchesSelect.appendChild(placeholder);
      for (const pattern of recentSearchPatterns) {
        const option = document.createElement("option");
        option.value = pattern;
        option.textContent = pattern;
        option.title = pattern;
        recentSearchesSelect.appendChild(option);
      }
    }

    async function loadRecentSearches() {
      try {
        const bag = await chrome.storage.local.get({ [RECENT_SEARCHES_KEY]: [] });
        const saved = bag[RECENT_SEARCHES_KEY];
        recentSearchPatterns = Array.isArray(saved)
          ? saved.filter((x) => typeof x === "string" && x.trim()).slice(0, MAX_RECENT_SEARCHES)
          : [];
      } catch (err) {
        console.warn("Could not load recent search patterns:", err);
        recentSearchPatterns = [];
      }
      renderRecentSearches();
    }

    async function rememberSearchPattern(value) {
      const pattern = String(value || "").trim();
      if (!pattern) return;
      // Treat case variants as the same pattern; keep the most recently used spelling.
      recentSearchPatterns = [pattern, ...recentSearchPatterns.filter(
        (old) => old.toLowerCase() !== pattern.toLowerCase()
      )].slice(0, MAX_RECENT_SEARCHES);
      renderRecentSearches();
      try {
        await chrome.storage.local.set({ [RECENT_SEARCHES_KEY]: recentSearchPatterns });
      } catch (err) {
        console.warn("Could not save recent search patterns:", err);
      }
    }

    let searchTimer = null;
    $("q").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => seek($("q").value.trim().toLowerCase()), 80);
    });
    // Save a completed pattern on Enter or when the search box loses focus,
    // rather than saving every intermediate keystroke as a separate pattern.
    $("q").addEventListener("keydown", (e) => {
      if (e.key === "Enter") rememberSearchPattern($("q").value);
    });
    $("q").addEventListener("change", () => rememberSearchPattern($("q").value));
    recentSearchesSelect.addEventListener("change", () => {
      const pattern = recentSearchesSelect.value;
      if (!pattern) return;
      $("q").value = pattern;
      seek(pattern.trim().toLowerCase());
      rememberSearchPattern(pattern);
      recentSearchesSelect.value = "";
      recentSearchesSelect.options[0].textContent = `Recent searches (${recentSearchPatterns.length}/${MAX_RECENT_SEARCHES})`;
    });
    loadRecentSearches();

    document.querySelector(".side").addEventListener("click", (e) => {
      const el = e.target.closest("[data-filter]");
      if (!el) return;
      document.querySelectorAll(".side [data-filter]").forEach((x) => x.classList.remove("on"));
      el.classList.add("on");
      filter = el.dataset.filter;
      seek($("q").value.trim().toLowerCase());
    });

    // Search-range controls live in the top banner and immediately re-run search.
    const inDateTimeBox = $("searchInDateTime");
    const inUrlBox = $("searchInUrl");
    const inTitleBox = $("searchInTitle");
    function applySearchRange() {
      searchInDateTime = inDateTimeBox.checked;
      searchInUrl = inUrlBox.checked;
      searchInTitle = inTitleBox.checked;
      seek($("q").value.trim().toLowerCase());
    }
    inDateTimeBox.checked = false;
    inUrlBox.checked = true;
    inTitleBox.checked = true;
    for (const box of [inDateTimeBox, inUrlBox, inTitleBox]) {
      box.addEventListener("change", applySearchRange);
    }

    const includeBox = $("includeComments");
    const includeLabel = $("includeCommentsLabel");
    function paintInclude(on) {
      includeComments = !!on;
      includeBox.checked = includeComments;
      includeLabel.textContent = includeComments ? "on" : "off";
    }
    chrome.storage.local.get({ includeComments: false }).then((bag) => {
      paintInclude(bag.includeComments);
      seek($("q").value.trim().toLowerCase());
    });
    includeBox.addEventListener("change", () => {
      paintInclude(includeBox.checked);
      chrome.storage.local.set({ includeComments: includeComments });
      seek($("q").value.trim().toLowerCase());
    });

    const expandUrlHitBox = $("expandCommentsOnUrlHit");
    const expandUrlHitLabel = $("expandCommentsOnUrlHitLabel");
    function paintExpandUrlHit(on) {
      expandCommentsOnUrlHit = !!on;
      expandUrlHitBox.checked = expandCommentsOnUrlHit;
      expandUrlHitLabel.textContent = expandCommentsOnUrlHit ? "on" : "off";
    }
    chrome.storage.local.get({ expandCommentsOnUrlHit: false }).then((bag) => {
      paintExpandUrlHit(bag.expandCommentsOnUrlHit);
      seek($("q").value.trim().toLowerCase());
    });
    expandUrlHitBox.addEventListener("change", () => {
      paintExpandUrlHit(expandUrlHitBox.checked);
      chrome.storage.local.set({ expandCommentsOnUrlHit });
      seek($("q").value.trim().toLowerCase());
    });

    const dedupeBox = $("dedupeCommentId");
    const dedupeLabel = $("dedupeCommentIdLabel");
    function paintDedupe(on) {
      dedupeCommentId = !!on;
      dedupeBox.checked = dedupeCommentId;
      dedupeLabel.textContent = dedupeCommentId ? "on" : "off";
    }
    chrome.storage.local.get({ dedupeCommentId: false }).then((bag) => {
      paintDedupe(bag.dedupeCommentId);
      seek($("q").value.trim().toLowerCase());
    });
    dedupeBox.addEventListener("change", () => {
      paintDedupe(dedupeBox.checked);
      chrome.storage.local.set({ dedupeCommentId: dedupeCommentId });
      seek($("q").value.trim().toLowerCase());
    });

    const dedupeTitleDailyBox = $("dedupeTitleDaily");
    const dedupeTitleDailyLabel = $("dedupeTitleDailyLabel");
    function paintDedupeTitleDaily(on) {
      dedupeTitleDaily = !!on;
      dedupeTitleDailyBox.checked = dedupeTitleDaily;
      dedupeTitleDailyLabel.textContent = dedupeTitleDaily ? "on" : "off";
    }
    chrome.storage.local.get({ dedupeTitleDaily: false }).then((bag) => {
      paintDedupeTitleDaily(bag.dedupeTitleDaily);
      seek($("q").value.trim().toLowerCase());
    });
    dedupeTitleDailyBox.addEventListener("change", () => {
      paintDedupeTitleDaily(dedupeTitleDailyBox.checked);
      chrome.storage.local.set({ dedupeTitleDaily: dedupeTitleDaily });
      seek($("q").value.trim().toLowerCase());
    });

    $("reloadBtn").onclick = () => refresh();
    $("newBtn").onclick = () => { setNow(); $("url").value=""; $("comments").value=""; $("dlg").classList.add("on"); };
    $("cancelBtn").onclick = () => $("dlg").classList.remove("on");
    $("saveBtn").onclick = async () => {
      if (!$("date").value || !$("time").value || !$("url").value.trim()) return;
      const added = await addRecord({
        date: $("date").value,
        time: $("time").value,
        url: $("url").value.trim(),
        title: "",
        comments: $("comments").value,
        createdAt: Date.now()
      });
      if (!added) {
        $("status").textContent = "Skipped: URL + comment already in DB";
        $("dlg").classList.remove("on");
        return;
      }
      $("dlg").classList.remove("on");
      await refresh();
    };

    $("delBtn").onclick = async () => {
      if (!selectedId) return;
      await deleteRecord(selectedId);
      selectedId = null;
      await refresh();
    };

    $("exportBtn").onclick = async () => {
      const blob = new Blob([JSON.stringify(await getAll(), null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "visit-comment-log.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    // Export the authoritative COMMENT_STORE records, plus one metadata entry per
    // video. The title comes from the newest history row for that video which has
    // a useful (non-placeholder) title; a canonical watch URL is the fallback.
    async function readAllFromStore(storeName) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        let tx;
        try {
          tx = db.transaction(storeName, "readonly");
        } catch (err) {
          reject(err);
          return;
        }
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error || new Error("Could not read " + storeName));
        tx.onabort = () => reject(tx.error || new Error("Read transaction aborted: " + storeName));
      });
    }

    function historyTimestamp(row) {
      const createdAt = row && row.createdAt;
      if (typeof createdAt === "number" && Number.isFinite(createdAt)) return createdAt;
      if (createdAt) {
        const parsed = Date.parse(createdAt);
        if (Number.isFinite(parsed)) return parsed;
      }
      const dateTime = [row && row.date, row && row.time].filter(Boolean).join("T");
      const parsedDateTime = Date.parse(dateTime);
      return Number.isFinite(parsedDateTime) ? parsedDateTime : 0;
    }

    function usefulVideoTitle(value) {
      const title = String(value || "").trim();
      if (!title) return "";
      if (/^(?:youtube|youtube\s*[-|:]?\s*(?:home|loading)|loading(?:\.\.\.)?)$/i.test(title)) return "";
      return title;
    }

    function triggerJsonDownload(filename, payload) {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }

    async function exportComments() {
      const [comments, history] = await Promise.all([
        readAllFromStore(COMMENT_STORE),
        getAll()
      ]);

      // Build the newest-first candidate history list for each video ID.
      const historyByVideo = new Map();
      for (const row of history) {
        const videoId = videoIdFromStoredUrl(row && row.url);
        if (!videoId) continue;
        const list = historyByVideo.get(videoId) || [];
        list.push(row);
        historyByVideo.set(videoId, list);
      }
      for (const list of historyByVideo.values()) {
        list.sort((a, b) => historyTimestamp(b) - historyTimestamp(a));
      }

      const videoIds = [...new Set(comments.map(c => String(c && c.videoId || "").trim()).filter(Boolean))].sort();
      const videos = videoIds.map(videoId => {
        const candidates = historyByVideo.get(videoId) || [];
        const titledRow = candidates.find(row => usefulVideoTitle(row.title));
        return {
          videoId,
          url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
          title: titledRow ? usefulVideoTitle(titledRow.title) : "",
          titleSource: titledRow ? "history" : "unavailable",
          titleRecordedAt: titledRow ? (titledRow.createdAt || null) : null,
          titleSourceUrl: titledRow ? String(titledRow.url || "") : ""
        };
      });

      triggerJsonDownload("youtube-comments.json", {
        format: "ai-chat-logger-comments",
        version: 1,
        exportedAt: new Date().toISOString(),
        videos,
        comments
      });
      $("status").textContent = `Exported ${comments.length} comments for ${videos.length} videos`;
    }

    $("exportCommentsBtn").onclick = async () => {
      const button = $("exportCommentsBtn");
      button.disabled = true;
      const oldText = button.textContent;
      button.textContent = "Exporting…";
      try {
        await exportComments();
      } catch (err) {
        console.error("Export Comments failed:", err);
        $("status").textContent = "Export Comments failed: " + (err && err.message ? err.message : String(err));
      } finally {
        button.disabled = false;
        button.textContent = oldText;
      }
    };
    let importMode = "history";
    $("importBtn").onclick = () => {
      importMode = "history";
      $("fileInput").accept = "application/json,.json";
      $("fileInput").click();
    };
    $("importCommentsBtn").onclick = () => {
      importMode = "comments";
      $("fileInput").accept = "application/json,.json";
      $("fileInput").click();
    };

    function dateTimeParts(value, fallbackValue = Date.now()) {
      let ms = 0;
      if (typeof value === "number" && Number.isFinite(value)) ms = value;
      else if (value) {
        const parsed = Date.parse(String(value));
        if (Number.isFinite(parsed)) ms = parsed;
      }
      if (!ms) {
        if (typeof fallbackValue === "number" && Number.isFinite(fallbackValue)) ms = fallbackValue;
        else ms = Date.now();
      }
      const d = new Date(ms);
      return {
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
        createdAt: ms
      };
    }

    async function addHistoryVideoIfMissing(video, exportedAt) {
      const videoId = String(video.videoId || "").trim();
      const url = String(video.url || (videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : "")).trim();
      if (!url) return false;
      const title = String(video.title || "").trim();
      const current = await getAll();
      // Exact URL+title pair semantics: same URL with a different title is a
      // distinct history row and must not be collapsed by addRecord()'s URL+notes rule.
      if (current.some((r) => normUrl(r.url) === normUrl(url) && String(r.title || "").trim() === title)) return false;
      const dt = dateTimeParts(video.titleRecordedAt || exportedAt || Date.now());
      await withStore("readwrite", (store) => store.add({
        date: dt.date,
        time: dt.time,
        url,
        title,
        comments: "",
        createdAt: dt.createdAt
      }));
      return true;
    }

    async function addImportedCommentIfMissing(input) {
      const videoId = String(input.videoId || "").trim();
      const commentId = String(input.commentId || "").trim();
      if (!videoId || !commentId) return false;
      const recordKey = String(input.recordKey || `${videoId}|${commentId}`);
      const row = { ...input, recordKey, videoId, commentId };
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(COMMENT_STORE, "readwrite");
        const store = tx.objectStore(COMMENT_STORE);
        const req = store.get(recordKey);
        let inserted = false;
        req.onsuccess = () => {
          if (req.result) return;
          try {
            store.add(row);
            inserted = true;
          } catch (err) {
            reject(err);
          }
        };
        req.onerror = () => reject(req.error || new Error("Could not check existing comment"));
        tx.oncomplete = () => resolve(inserted);
        tx.onerror = () => reject(tx.error || new Error("Could not import comment"));
        tx.onabort = () => reject(tx.error || new Error("Comment import transaction aborted"));
      });
    }

    $("fileInput").onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const mode = importMode;
      try {
        const data = JSON.parse(await file.text());
        if (mode === "history") {
          if (!Array.isArray(data)) throw new Error("History import expects a JSON array.");
          let added = 0;
          for (const row of data) {
            const { id, ...rest } = row;
            if (await addRecord({
              date: rest.date || "",
              time: rest.time || "",
              url: rest.url || "",
              title: rest.title || "",
              comments: rest.comments || "",
              createdAt: rest.createdAt || Date.now()
            })) added++;
          }
          await refresh();
          $("status").textContent = `History import complete · ${added} rows added`;
        } else {
          if (!data || !Array.isArray(data.videos) || !Array.isArray(data.comments)) {
            throw new Error("Comments import expects youtube-comments.json with videos[] and comments[].");
          }
          let videosAdded = 0;
          let commentsAdded = 0;
          let commentsSkipped = 0;
          for (const video of data.videos) {
            if (await addHistoryVideoIfMissing(video || {}, data.exportedAt)) videosAdded++;
          }
          for (const comment of data.comments) {
            if (await addImportedCommentIfMissing(comment || {})) commentsAdded++;
            else commentsSkipped++;
          }
          await refresh();
          await loadCommentsIndex();
          seek($("q").value.trim().toLowerCase());
          $("status").textContent = `Comments import complete · ${videosAdded} video history rows added · ${commentsAdded} comments added · ${commentsSkipped} skipped (duplicate/invalid)`;
        }
      } catch (err) {
        console.error("Import failed:", err);
        $("status").textContent = "Import failed: " + (err && err.message ? err.message : String(err));
      } finally {
        e.target.value = "";
      }
    };

    refresh();


    let hashRows = [];
    let hashPages = new Map();
    let recycleRows = [];
    let hashFilter = "all";
    let openHashVideos = new Set();
    let hashMenuTarget = null;
    let hashIncludeComments = false;
    let hashExpandOnHit = false;
    let hashDedupeFirstSeenId = false;
    let hashDedupeTitleDaily = false;

    function pageIdOf(url) {
      return videoIdFromStoredUrl(url) || "";
    }

    async function loadHashData() {
      const db = await openDb();
      const allTexts = await new Promise((resolve, reject) => {
        const req = db.transaction(HASH_TEXT_STORE, "readonly").objectStore(HASH_TEXT_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      const allPages = await new Promise((resolve, reject) => {
        const req = db.transaction(HASH_PAGE_STORE, "readonly").objectStore(HASH_PAGE_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      recycleRows = await new Promise((resolve, reject) => {
        try {
          const req = db.transaction(HASH_RECYCLE_STORE, "readonly").objectStore(HASH_RECYCLE_STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        } catch (_) { resolve([]); }
      });
      hashRows = allTexts;
      hashPages = new Map(allPages.map((p) => [p.pageId, p.hashes || []]));
      paintHash();
    }

    function textFor(key) {
      return hashRows.find((r) => r.hashKey === key) || null;
    }

    function pageEntry(item) {
      if (item && typeof item === "object") return { key: String(item.key || ""), firstSeen: item.firstSeen || 0 };
      return { key: String(item || ""), firstSeen: 0 };
    }

    function seenStamp(ms) {
      if (!ms) return "";
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }

    function greenHit(text, q) {
      const raw = String(text || "");
      if (!q) return esc(raw);
      const i = raw.toLowerCase().indexOf(q);
      if (i < 0) return esc(raw);
      return esc(raw.slice(0, i)) + '<span style="color:#00ff00;font-weight:700">' + esc(raw.slice(i, i + q.length)) + "</span>" + esc(raw.slice(i + q.length));
    }

    function hashItemHtml(item, pageId, q) {
      const entry = pageEntry(item);
      const row = textFor(entry.key);
      const author = row ? row.author : entry.key.split("|")[0];
      const text = row ? row.text : "";
      const when = seenStamp(entry.firstSeen);
      return `<div class="hash-item" data-hash="${esc(entry.key)}" data-page="${esc(pageId)}" style="padding:4px 0;border-top:1px solid #eee;">
        ${when ? esc(when) + " " : ""}<b>${greenHit(author, q)}</b> ${greenHit(text, q)}
      </div>`;
    }

    function uniquePairs(items) {
      const entries = items.map(pageEntry);
      if (!hashDedupeFirstSeenId) return entries;
      const seen = new Set();
      return entries.filter((e) => {
        const pair = e.firstSeen + "|" + e.key;
        if (seen.has(pair)) return false;
        seen.add(pair);
        return true;
      });
    }

    function newestTitlePerDay(list) {
      if (!hashDedupeTitleDaily) return list;
      const winner = new Map();
      const value = (r) => {
        const n = Date.parse(String(r.date || "") + "T" + String(r.time || "00:00"));
        return Number.isFinite(n) ? n : -Infinity;
      };
      for (const r of list) {
        const title = String(r.title || "").trim();
        if (!title) continue;
        const key = String(r.date || "") + "|" + title;
        const cur = winner.get(key);
        if (!cur || value(r) > value(cur)) winner.set(key, r);
      }
      const keep = new Set(winner.values());
      return list.filter((r) => !String(r.title || "").trim() || keep.has(r));
    }


    function oneRowPerPage(list) {
      const winner = new Map();
      const realTitle = (r) => {
        const t = String(r.title || "").trim();
        return t && !/youtube|loading/i.test(t);
      };
      const better = (a, b) => {
        const ar = realTitle(a), br = realTitle(b);
        if (ar !== br) return ar;
        return (a.createdAt || 0) > (b.createdAt || 0);
      };
      const rest = [];
      for (const r of list) {
        const id = pageIdOf(r.url);
        if (!id) { rest.push(r); continue; }
        const cur = winner.get(id);
        if (!cur || better(r, cur)) winner.set(id, r);
      }
      return rest.concat([...winner.values()]);
    }

    function paintHash() {
      const tb = $("tbodyHash");
      if (!tb) return;
      const q = ($("qHash")?.value || "").trim().toLowerCase();
      if (hashFilter === "recycle") {
        const shown = recycleRows.filter((r) => !q || [r.author, r.text, r.pageId, r.originalKey].join(" ").toLowerCase().includes(q));
        tb.innerHTML = shown.map((r) => `<tr class="hash-recycle" data-recycle="${esc(r.recycleKey)}">
          <td colspan="5"><b>${esc(r.author || "")}</b> ${esc(r.text || "")}<br><span style="color:#777">${esc(r.pageId || "")} · ${esc(r.originalKey || "")}</span></td>
        </tr>`).join("");
        $("emptyHash").hidden = shown.length > 0;
        $("statusHash").textContent = shown.length + " recycled";
        return;
      }
      let list = rows.filter((r) => {
        const url = String(r.url || "");
        if (hashFilter === "yt") return /youtube\.com|youtu\.be/i.test(url);
        if (hashFilter === "other") return !/youtube\.com|youtu\.be/i.test(url);
        return true;
      });
      list = newestTitlePerDay(list);
      list = oneRowPerPage(list);
      list = list.filter((r) => {
        if (!q) return true;
        const urlHit = [r.title, r.url, r.date].join(" ").toLowerCase().includes(q);
        if (urlHit) return true;
        if (!hashIncludeComments) return false;
        return (hashPages.get(pageIdOf(r.url)) || []).some((k) => {
          const entry = pageEntry(k);
          const row = textFor(entry.key);
          return (row && (row.author + " " + row.text).toLowerCase().includes(q)) || entry.key.toLowerCase().includes(q);
        });
      });
      tb.innerHTML = list.map((r) => {
        const vid = pageIdOf(r.url);
        const keys = hashPages.get(vid) || [];
        const entries = uniquePairs(keys);
        const urlHit = !!q && [r.title, r.url, r.date].join(" ").toLowerCase().includes(q);
        const innerHit = hashIncludeComments && entries.some((e) => {
          const row = textFor(e.key);
          return (row && (row.author + " " + row.text).toLowerCase().includes(q)) || e.key.toLowerCase().includes(q);
        });
        const show = vid && (openHashVideos.has(vid) || (hashExpandOnHit && (urlHit || innerHit)));
        const fold = vid && entries.length ? `<button class="fold hash-fold" data-vid="${esc(vid)}" type="button">${show ? "–" : "+"}</button>` : "";
        const detail = show ? `<tr class="cmt-row"><td colspan="5">${entries.map((e) => hashItemHtml(e, vid, q)).join("")}</td></tr>` : "";
        return `<tr data-id="${r.id}">
          <td>${esc(r.date)}</td><td>${esc(r.time)}</td>
          <td>${fold}${greenHit(r.title || "", q)}</td>
          <td>${greenHit(r.url || "", q)}</td>
          <td>${r.id}</td>
        </tr>${detail}`;
      }).join("");
      $("emptyHash").hidden = list.length > 0;
      $("statusHash").textContent = list.length + " url rows";
    }

    $("qHash")?.addEventListener("input", paintHash);
    $("reloadHashBtn")?.addEventListener("click", loadHashData);
    document.querySelector("#panel-hash .side")?.addEventListener("click", (e) => {
      const el = e.target.closest("[data-filter]");
      if (!el) return;
      document.querySelectorAll("#panel-hash .side [data-filter]").forEach((x) => x.classList.remove("on"));
      el.classList.add("on");
      hashFilter = el.dataset.filter;
      paintHash();
    });
    $("tbodyHash")?.addEventListener("click", (e) => {
      const fold = e.target.closest(".hash-fold");
      if (!fold) return;
      const vid = fold.dataset.vid;
      if (openHashVideos.has(vid)) openHashVideos.delete(vid);
      else openHashVideos.add(vid);
      paintHash();
    });
    $("tbodyHash")?.addEventListener("contextmenu", (e) => {
      const item = e.target.closest(".hash-item, .hash-recycle");
      if (!item) return;
      e.preventDefault();
      hashMenuTarget = item;
      const menu = $("hashMenu");
      $("hashMenuDelete").style.display = item.classList.contains("hash-item") ? "block" : "none";
      $("hashMenuRecover").style.display = item.classList.contains("hash-recycle") ? "block" : "none";
      menu.style.display = "block";
      menu.style.left = e.clientX + "px";
      menu.style.top = e.clientY + "px";
    });
    document.addEventListener("click", () => { const m = $("hashMenu"); if (m) m.style.display = "none"; });
    $("hashMenuDelete")?.addEventListener("click", async () => {
      if (!hashMenuTarget) return;
      await recycleHashItem(hashMenuTarget.dataset.page, hashMenuTarget.dataset.hash);
      await loadHashData();
    });
    $("hashMenuRecover")?.addEventListener("click", async () => {
      if (!hashMenuTarget) return;
      const key = hashMenuTarget.dataset.recycle;
      const rec = recycleRows.find((r) => r.recycleKey === key);
      const existing = rec && textFor(rec.originalKey);
      let overwrite = false;
      if (existing && existing.text) {
        overwrite = confirm("Original key already has text. Overwrite it?");
        if (!overwrite) return;
      }
      await recoverHashItem(key, true);
      await loadHashData();
    });

    chrome.storage.local.get({ lastExplorerTab: "permalink" }).then((bag) => {
      if (bag.lastExplorerTab === "hash") {
        const radio = document.getElementById("tab-hash");
        if (radio) radio.checked = true;
      }
    });
    document.getElementById("tab-permalink")?.addEventListener("change", () => {
      if (document.getElementById("tab-permalink").checked) chrome.storage.local.set({ lastExplorerTab: "permalink" });
    });
    document.getElementById("tab-hash")?.addEventListener("change", () => {
      if (document.getElementById("tab-hash").checked) chrome.storage.local.set({ lastExplorerTab: "hash" });
    });

    const HASH_FLAGS = ["hashIncludeComments", "hashExpandOnHit", "hashDedupeFirstSeenId", "hashDedupeTitleDaily"];
    chrome.storage.local.get({
      hashIncludeComments: false,
      hashExpandOnHit: false,
      hashDedupeFirstSeenId: false,
      hashDedupeTitleDaily: false
    }).then((bag) => {
      hashIncludeComments = !!bag.hashIncludeComments;
      hashExpandOnHit = !!bag.hashExpandOnHit;
      hashDedupeFirstSeenId = !!bag.hashDedupeFirstSeenId;
      hashDedupeTitleDaily = !!bag.hashDedupeTitleDaily;
      for (const key of HASH_FLAGS) {
        const box = $(key);
        const label = $(key + "Label");
        if (box) box.checked = !!bag[key];
        if (label) label.textContent = bag[key] ? "on" : "off";
      }
      paintHash();
    });
    for (const key of HASH_FLAGS) {
      $(key)?.addEventListener("change", () => {
        const on = $(key).checked;
        if (key === "hashIncludeComments") hashIncludeComments = on;
        if (key === "hashExpandOnHit") hashExpandOnHit = on;
        if (key === "hashDedupeFirstSeenId") hashDedupeFirstSeenId = on;
        if (key === "hashDedupeTitleDaily") hashDedupeTitleDaily = on;
        chrome.storage.local.set({ [key]: on });
        const label = $(key + "Label");
        if (label) label.textContent = on ? "on" : "off";
        paintHash();
      });
    }

    loadHashData();
