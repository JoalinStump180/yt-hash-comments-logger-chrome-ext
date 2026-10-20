// ==UserScript==
// @name         Hash tab tester
// @namespace    hash-tab-tester
// @version      0.1
// @match        *://*.youtube.com/*
// @grant        none
// ==/UserScript==
(() => {
  "use strict";
  const DB_NAME = "hashTabTester";
  const STORE = "hashTexts";
  const DEFAULT_BLOCKS = "ytd-comment-view-model ytd-backstage-post-renderer";
  const DEFAULT_AUTHOR = "#author-text";
  const DEFAULT_TEXT = "yt-attributed-string#content-text yt-formatted-string#content-text";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "hashKey" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function cheapHash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
    return (h >>> 0).toString(16);
  }

  function pageId() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const parts = u.pathname.split("/").filter(Boolean);
      const host = u.hostname.replace(/^www\./, "");
      if (host === "youtu.be") return parts[0] || "";
      if (parts[0] === "post" || parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") return parts[1] || "";
    } catch {}
    return "";
  }

  function firstText(root, textSels) {
    for (const sel of textSels) {
      let hit = null;
      try { hit = root.querySelector(sel); } catch { continue; }
      const val = (hit && hit.innerText || "").trim();
      if (val) return val;
    }
    return "";
  }

  function collect(selectors, authorSel, textSels) {
    const id = pageId();
    if (!id) return [];
    const out = [];
    const seen = new Set();
    for (const sel of selectors) {
      let nodes = [];
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      for (const A of nodes) {
        let authorNode = null;
        try { authorNode = A.querySelector(authorSel) || A.querySelector('a[href*="/@"]'); } catch { continue; }
        if (!authorNode) continue;
        const href = authorNode.getAttribute("href") || "";
        const handle = href.match(/\/@([\w.-]+)/);
        const author = handle ? "@" + handle[1] : (authorNode.innerText || "").trim();
        let text = "";
        let B = authorNode.parentElement;
        while (B && A.contains(B)) {
          text = firstText(B, textSels);
          if (text) break;
          if (B === A) break;
          B = B.parentElement;
        }
        if (!text) continue;
        const hashKey = author + "|" + cheapHash(text);
        if (seen.has(hashKey)) continue;
        seen.add(hashKey);
        out.push({ hashKey, author, text, pageId: id, sourceUrl: location.href });
      }
    }
    return out;
  }

  function getRow(db, key) {
    return new Promise((resolve) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  function putRow(db, row) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  const box = document.createElement("div");
  box.id = "ai-seen-debug";
  box.style.cssText = "position:fixed;top:72px;right:12px;z-index:2147483646;width:460px;max-height:46vh;overflow:auto;background:rgba(12,16,24,.62);color:#f2f2f2;font:12px/1.45 Consolas,monospace;padding:8px 10px;border:1px solid rgba(255,255,255,.25);border-radius:8px;";
  const bar = document.createElement("div");
  bar.textContent = "seen debug (drag)";
  bar.style.cssText = "cursor:move;font-weight:600;margin-bottom:6px;";
  function makeBar(key, fallback, label) {
    const wrap = document.createElement("div");
    wrap.style.margin = "0 0 6px";
    const lab = document.createElement("div");
    lab.textContent = label;
    lab.style.cssText = "font-size:10px;color:#bbb;margin-bottom:2px;";
    const input = document.createElement("input");
    input.type = "text";
    input.value = localStorage.getItem(key) || fallback;
    input.style.cssText = "width:100%;box-sizing:border-box;background:#111;color:#fff;border:1px solid #666;padding:3px 6px;font:inherit;";
    input.addEventListener("change", () => localStorage.setItem(key, input.value));
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return { wrap, input };
  }
  const blocks = makeBar("hashTabBlocks", DEFAULT_BLOCKS, "1. blocks");
  const authorBar = makeBar("hashTabAuthor", DEFAULT_AUTHOR, "2. author");
  const textBar = makeBar("hashTabText", DEFAULT_TEXT, "3. text checkpoints");
  const pre = document.createElement("pre");
  pre.id = "ai-seen-debug-log";
  pre.style.cssText = "margin:0;white-space:pre-wrap;";
  box.appendChild(bar);
  box.appendChild(blocks.wrap);
  box.appendChild(authorBar.wrap);
  box.appendChild(textBar.wrap);
  box.appendChild(pre);
  document.documentElement.appendChild(box);
  let drag = false, dx = 0, dy = 0;
  bar.addEventListener("mousedown", (e) => { drag = true; dx = e.clientX - box.offsetLeft; dy = e.clientY - box.offsetTop; });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    box.style.left = (e.clientX - dx) + "px";
    box.style.top = (e.clientY - dy) + "px";
    box.style.right = "auto";
  });
  window.addEventListener("mouseup", () => { drag = false; });

  const shown = new Set();
  function log(line) {
    pre.textContent = (line + "\n" + pre.textContent).slice(0, 5000);
  }

  async function tick() {
    const selectors = blocks.input.value.split(/\s+/).filter(Boolean);
    const authorSel = authorBar.input.value.trim() || DEFAULT_AUTHOR;
    const textSels = textBar.input.value.split(/\s+/).filter(Boolean);
    const batch = collect(selectors, authorSel, textSels);
    if (!batch.length) return;
    const db = await openDb();
    for (const row of batch) {
      if (shown.has(row.hashKey)) continue;
      shown.add(row.hashKey);
      const existing = await getRow(db, row.hashKey);
      const two = row.text.split(/\n/).slice(0, 2).join(" / ");
      if (existing) {
        log("ALREADY " + row.author + " " + new Date(existing.createdAt).toLocaleString() + " " + row.sourceUrl + " " + two);
      } else {
        await putRow(db, { ...row, createdAt: Date.now() });
        log("NEW " + row.author + " " + two);
      }
    }
  }

  setInterval(() => { tick().catch((err) => log("error " + err)); }, 1000);
  log("hash tab tester ready");
})();
