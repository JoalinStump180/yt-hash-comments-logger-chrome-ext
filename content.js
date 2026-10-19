
// Listen for any link clicks on the page
document.addEventListener('click', (e) => {
  const link = e.target.closest('a');
  if (!link) return;

  // Grab the URL it points to (from href or a custom attribute)
  const targetUrl = link.href;
  const linkText = link.textContent.trim();

  // If it's one of your tracked/test links (or you want to log all links)
  if (targetUrl && targetUrl !== window.location.href) {
    console.log('[Content Script] Captured link click:', targetUrl);

    // Send the data to your background script
    chrome.runtime.sendMessage({
      type: 'logCustomHistory',
      url: targetUrl,
      title: `Clicked: ${linkText}`,
      date: new Date().toLocaleDateString(),
      time: new Date().toLocaleTimeString()
    });
  }
});

 
window.addEventListener('page-title2', (e) => {

console.log('[Content.js page-title2 Received]:', e.detail.url, e.detail.title);
  // Step 2: Relay to background.js using extension APIs
  chrome.runtime.sendMessage({
    type: "page-title2",
    url: e.detail.url,
    title: e.detail.title
  });
});

window.addEventListener('logCustomHistory', (e) => {
  // 1. Show an alert box with the captured data
    console.log('[Content.js Received]:', e.detail.url, e.detail.title);
  alert(`[Content Script Caught It!]\nURL: ${e.detail.url}\nTitle: ${e.detail.title}`);

  // 2. Forward to your background script
  chrome.runtime.sendMessage({
    type: 'logCustomHistory',
    url: e.detail.url,
    title: e.detail.title,
    date: e.detail.date,
    time: e.detail.time
  }).catch(() => {});
});











// --- SPA / History Change Logger for Content Script ---
function bindHistoryLogger() {
  const notifyUrlChange = () => {
    const currentUrl = location.href;
    const currentTitle = document.title || currentUrl;
    console.log('[Content.js bindHistoryLogger notifyUrlChange Received]:', currentUrl, currentTitle);
     //alert(`[Content Script  bindHistoryLogger notifyUrlChange !]\nURL: ${currentUrl}\nTitle: ${currentTitle}`);      ---- this msgbox will be disp'd  when you clickk the browser ' s prev/next page button. 
    // Send to background service worker to record in IndexedDB
    chrome.runtime.sendMessage({
      type: "page-title2",
      url: currentUrl,
      title: currentTitle
    }).catch(() => {});
  };

  // 1. Monkey-patch pushState & replaceState
  const origPush = history.pushState;
  history.pushState = function (...args) {
    origPush.apply(this, args);
    notifyUrlChange();
  };

  const origReplace = history.replaceState;
  history.replaceState = function (...args) {
    origReplace.apply(this, args);
    notifyUrlChange();
  };

  // 2. Listen to back/forward and hash changes
  window.addEventListener("popstate", notifyUrlChange);
  window.addEventListener("hashchange", notifyUrlChange);
}

// Initialize on page load
bindHistoryLogger();


function videoIdFromLocation() {
  try {
    const u = new URL(location.href);
    const host = u.hostname.replace(/^www\./, "");
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    if (host === "youtu.be") return parts[0] || "";
    if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") return parts[1] || "";
  } catch {}
  return "";
}

function postIdFromLocation() {
  try {
    const u = new URL(location.href);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "post") return parts[1] || "";
  } catch {}
  return "";
}

function walk(obj, depth, bag) {
  if (!obj || depth > 5 || typeof obj !== "object") return;
  try {
    if (typeof obj.commentId === "string") bag.commentId = bag.commentId || obj.commentId;
    if (typeof obj.comment_id === "string") bag.commentId = bag.comment_id || obj.comment_id;
    if (typeof obj.channelId === "string" && obj.channelId.startsWith("UC")) bag.channelId = bag.channelId || obj.channelId;
    if (typeof obj.browseId === "string" && obj.browseId.startsWith("UC")) bag.channelId = bag.channelId || obj.browseId;
    if (typeof obj.authorText === "string") bag.author = bag.author || obj.authorText;
    if (obj.authorText && typeof obj.authorText.simpleText === "string") bag.author = bag.author || obj.authorText.simpleText;
    if (typeof obj.publishedTime === "string") bag.publishedTime = bag.publishedTime || obj.publishedTime;
    if (typeof obj.publishedTimeText === "string") bag.publishedTime = bag.publishedTime || obj.publishedTimeText;
    if (obj.publishedTimeText && typeof obj.publishedTimeText.simpleText === "string") {
      bag.publishedTime = bag.publishedTime || obj.publishedTimeText.simpleText;
    }
  } catch {}
  const keys = ["__data", "data", "polymerController", "comment", "commentViewModel", "properties", "author", "authorEndpoint", "browseEndpoint"];
  for (const k of keys) {
    try { if (obj[k]) walk(obj[k], depth + 1, bag); } catch {}
  }
}

function idFromHref(el) {
  const a = el.querySelector?.('a[href*="lc="]') || el.closest?.("ytd-comment-thread-renderer")?.querySelector('a[href*="lc="]');
  const href = a?.getAttribute("href") || "";
  const m = href.match(/[?&]lc=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function commentIdFromEl(el) {
  const bag = {};
  walk(el, 0, bag);
  return bag.commentId || idFromHref(el) || el.getAttribute?.("comment-id") || "";
}

function metaFromEl(el) {
  const bag = {};
  walk(el, 0, bag);
  const authorA =
    el.querySelector("#author-text") ||
    el.querySelector("a#author-text") ||
    el.querySelector("#author-name a") ||
    el.querySelector("#name a") ||
    el.querySelector('a[href*="/channel/"]') ||
    el.querySelector('a[href*="/@"]');
  const href = authorA?.getAttribute("href") || "";
  const uc = href.match(/\/channel\/(UC[\w-]+)/);
  const handle = href.match(/\/@([\w.-]+)/);
  const timeNode =
    el.querySelector("#published-time-text") ||
    el.querySelector("yt-formatted-string.published-time-text") ||
    el.querySelector("#header-author #published-time-text");
  return {
    author: (bag.author || authorFromEl(el) || authorA?.innerText || "").trim(),
    handle: handle ? "@" + handle[1] : "",
    channelId: bag.channelId || (uc ? uc[1] : ""),
    publishedTime: bag.publishedTime || (timeNode?.innerText || "").trim()
  };
}

function textFromEl(el) {
  const node =
    el.querySelector("#content-text") ||
    el.querySelector("#content-text yt-attributed-string") ||
    el.querySelector("yt-attributed-string") ||
    el.querySelector("#comment-content") ||
    el.querySelector("#content");
  return (node?.innerText || "").trim();
}

function authorFromEl(el) {
  const node =
    el.querySelector("#author-text") ||
    el.querySelector("#author-name") ||
    el.querySelector("a#author-text") ||
    el.querySelector("#name");
  return (node?.innerText || "").trim();
}

function fallbackId(videoId, author, text) {
  const s = `${videoId}|${author}|${text}`.slice(0, 400);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return "local-" + (h >>> 0).toString(16);
}

function permalinkParts(el) {
  const a = el.querySelector?.('a[href*="lc="]')
    || el.closest?.("ytd-comment-thread-renderer")?.querySelector('a[href*="lc="]');
  const href = a?.getAttribute("href") || "";
  const vMatch = href.match(/[?&]v=([^&]+)/);
  const lcMatch = href.match(/[?&]lc=([^&]+)/);
  return {
    videoId: vMatch ? vMatch[1] : "",
    commentId: lcMatch ? decodeURIComponent(lcMatch[1]) : ""
  };
}

function collectVisible() {
  const pageVideoId = videoIdFromLocation();
  const pagePostId = postIdFromLocation();
  const currentPageId = pageVideoId || pagePostId;

  if (!currentPageId) return [];

  const nodes = document.querySelectorAll(
    "ytd-comment-view-model, ytd-comment-renderer, ytd-comment-thread-renderer"
  );
  const out = [];
  const seen = new Set();

  for (const el of nodes) {
    const unit = el.tagName === "YTD-COMMENT-THREAD-RENDERER"
      ? (el.querySelector("ytd-comment-view-model, ytd-comment-renderer") || el)
      : el;
    const text = textFromEl(unit) || textFromEl(el);
    if (!text) continue;

    const link = permalinkParts(unit);
    const link2 = link.videoId ? link : permalinkParts(el);
    const targetId = link2.videoId || currentPageId;

    const meta = Object.assign(metaFromEl(el), metaFromEl(unit));
    const author = meta.author || authorFromEl(unit) || authorFromEl(el);
    let commentId = link2.commentId || commentIdFromEl(unit) || commentIdFromEl(el);
    if (!commentId) commentId = fallbackId(targetId, author, text);

    if (seen.has(targetId + "|" + commentId)) continue;
    seen.add(targetId + "|" + commentId);

    out.push({
      videoId: targetId,
      commentId,
      author,
      handle: meta.handle || (author.startsWith("@") ? author : ""),
      channelId: meta.channelId || "",
      publishedTime: meta.publishedTime || "",
      text,
      sourceUrl: location.href,
      pageVideoId: currentPageId
    });
  }
  return out;
}

const shownIds = new Set();
let overlay;
let overlayEnabled = true;

function applyOverlayVisibility() {
  if (!overlayEnabled) {
    if (overlay && overlay.isConnected) overlay.style.display = "none";
    return;
  }
  const box = ensureOverlay();
  box.style.display = "";
}

function ensureOverlay() {
  if (overlay && overlay.isConnected) return overlay;
  overlay = document.getElementById("vul-debug-overlay");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "vul-debug-overlay";
  overlay.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "width:280px",
    "max-height:160px",
    "overflow:hidden",
    "z-index:2147483647",
    "pointer-events:none",
    "background:rgba(0,0,0,.45)",
    "color:#d7ffd7",
    "font:11px/1.35 Consolas,Segoe UI,sans-serif",
    "padding:6px 8px",
    "border-radius:6px",
    "text-shadow:0 1px 1px #000"
  ].join(";");
  (document.documentElement || document.body).appendChild(overlay);
  if (!overlayEnabled) overlay.style.display = "none";
  return overlay;
}

function rollLine(author, text) {
  if (!overlayEnabled) return;
  const box = ensureOverlay();
  box.style.display = "";
  const line = document.createElement("div");
  line.style.margin = "0 0 4px";
  line.style.whiteSpace = "pre-wrap";
  line.style.wordBreak = "break-word";
  const who = author ? "@" + String(author).replace(/\s+/g, "") : "@unknown";
  const body = String(text || "").replace(/\s+/g, " ").slice(0, 160);
  line.textContent = who + "  " + body;
  box.appendChild(line);
  while (box.childElementCount > 6) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

chrome.storage.local.get({ showCommentsOverlay: true }).then((bag) => {
  overlayEnabled = bag.showCommentsOverlay !== false;
  applyOverlayVisibility();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.showCommentsOverlay) return;
  overlayEnabled = changes.showCommentsOverlay.newValue !== false;
  applyOverlayVisibility();
});


let flushTimer = null;
function scheduleFlush(delay = 200) {
  const waitMs = typeof delay === "number" ? delay : 200;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    const bag = await chrome.storage.local.get({
      commentsLogging: false,
      showCommentsOverlay: true
    });
    overlayEnabled = bag.showCommentsOverlay !== false;
    applyOverlayVisibility();
    if (!bag.commentsLogging && !overlayEnabled) return;
    const batch = collectVisible();
    if (!batch.length) return;
    const pageContext = videoIdFromLocation() || postIdFromLocation();
    const fresh = batch.filter((c) => !shownIds.has(c.videoId + "|" + c.commentId));
    if (overlayEnabled) {
      for (const c of fresh) {
        if (c.videoId !== pageContext) continue;
        shownIds.add(c.videoId + "|" + c.commentId);
        rollLine(c.handle || c.author, (c.channelId ? c.channelId + "  " : "") + (c.publishedTime ? c.publishedTime + "  " : "") + c.text);
      }
    }
    if (!bag.commentsLogging) return;
    chrome.runtime.sendMessage({ type: "yt-comments", batch }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.off) return;
      if (!overlayEnabled) {
        for (const c of fresh) shownIds.add(c.videoId + "|" + c.commentId);
      }
    });
  }, waitMs);
}

const obs = new MutationObserver(scheduleFlush);

function arm() {
  obs.disconnect();
  obs.observe(document.body, { childList: true, subtree: true });
  scheduleFlush(100);
}

document.addEventListener("yt-navigate-start", () => {
  obs.disconnect();
  clearTimeout(flushTimer);
});

document.addEventListener("yt-navigate-finish", () => {
  arm();
  setTimeout(() => scheduleFlush(100), 500);
  setTimeout(() => scheduleFlush(100), 1500);
});

window.addEventListener("scroll", () => scheduleFlush(300), { passive: true });
window.addEventListener("load", arm);
setInterval(scheduleFlush, 1000);