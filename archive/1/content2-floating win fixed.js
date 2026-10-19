(() => {
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

  function cheapHash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
    return (h >>> 0).toString(16);
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

  function collectHashBlocks(selectors, authorSel, textSels) {
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
        out.push({ hashKey, author, text, pageId: id, selector: sel, sourceUrl: location.href });
      }
    }
    return out;
  }

  const LAYOUT_KEY = "hashOverlayLayout";
  let overlayOn = false;
  let box = null;
  let folded = false;

  function twoLines(text) {
    return String(text || "").split(/\n/).slice(0, 2).join("\n");
  }

  function stamp(ms) {
    const d = new Date(ms || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function saveLayout() {
    if (!box) return;
    chrome.storage.local.set({
      [LAYOUT_KEY]: {
        left: box.offsetLeft,
        top: box.offsetTop,
        width: box.offsetWidth,
        height: box.offsetHeight,
        folded
      }
    });
  }

  function applyFold() {
    const body = box.querySelector(".vul-hash-body");
    const saveBars = () => chrome.storage.local.set({
      hashBlocks: box.querySelector(".vul-hash-blocks").value.trim(),
      hashAuthor: box.querySelector(".vul-hash-author").value.trim(),
      hashText: box.querySelector(".vul-hash-text").value.trim()
    });
    for (const sel of [".vul-hash-blocks", ".vul-hash-author", ".vul-hash-text"]) {
      box.querySelector(sel).addEventListener("change", saveBars);
    }
    const handle = box.querySelector(".vul-hash-resize");
    body.style.display = folded ? "none" : "";
    handle.style.display = folded ? "none" : "";
    box.style.height = folded ? "24px" : (box.dataset.h || "180px");
  }

  function ensureBox() {
    if (box && box.isConnected && box.querySelector(".vul-hash-blocks")) return box;
    box = document.getElementById("vul-hash-overlay");
    if (box && !box.querySelector(".vul-hash-blocks")) {
      box.remove();
      box = null;
    }
    if (box) return box;
    box = document.createElement("div");
    box.id = "vul-hash-overlay";
    box.style.cssText = [
      "position:fixed",
      "left:16px",
      "top:16px",
      "width:520px",
      "height:280px",
      "z-index:2147483646",
      "background:rgba(12,16,24,.62)",
      "color:#f2f2f2",
      "font:12px/1.45 Consolas,monospace",
      "border:1px solid rgba(255,255,255,.25)",
      "border-radius:8px",
      "overflow:hidden",
      "display:none"
    ].join(";");
    box.innerHTML = [
      '<div class="vul-hash-bar" style="height:24px;background:rgba(0,0,0,.55);cursor:move;display:flex;align-items:center;padding:0 6px;user-select:none;">',
      '<span style="flex:1">seen debug (drag)</span>',
      '<button class="vul-hash-fold" type="button" style="height:18px;border:0;background:#444;color:#fff;cursor:pointer;">_</button>',
      '</div>',
      '<div class="vul-hash-bars" style="padding:6px 8px 0;">',
      '<div style="font-size:10px;color:#bbb;">1. blocks</div>',
      '<input class="vul-hash-blocks" type="text" style="width:100%;box-sizing:border-box;margin:0 0 6px;background:#111;color:#fff;border:1px solid #666;padding:3px 6px;font:inherit;" />',
      '<div style="font-size:10px;color:#bbb;">2. author</div>',
      '<input class="vul-hash-author" type="text" style="width:100%;box-sizing:border-box;margin:0 0 6px;background:#111;color:#fff;border:1px solid #666;padding:3px 6px;font:inherit;" />',
      '<div style="font-size:10px;color:#bbb;">3. text checkpoints</div>',
      '<input class="vul-hash-text" type="text" style="width:100%;box-sizing:border-box;margin:0 0 6px;background:#111;color:#fff;border:1px solid #666;padding:3px 6px;font:inherit;" />',
      '</div>',
      '<div class="vul-hash-body" style="height:120px;overflow:auto;padding:6px;white-space:pre-wrap;"></div>',
      '<div class="vul-hash-resize" style="position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;background:rgba(255,255,255,.35);"></div>'
    ].join("");
    (document.documentElement || document.body).appendChild(box);
    if (overlayOn) box.style.display = "";

    const bar = box.querySelector(".vul-hash-bar");
    bar.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      const sx = e.clientX, sy = e.clientY, sl = box.offsetLeft, st = box.offsetTop;
      const move = (ev) => {
        box.style.left = (sl + ev.clientX - sx) + "px";
        box.style.top = (st + ev.clientY - sy) + "px";
        box.style.right = "auto";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        saveLayout();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    box.querySelector(".vul-hash-fold").addEventListener("click", () => {
      folded = !folded;
      applyFold();
      saveLayout();
    });
    const saveBars = () => chrome.storage.local.set({
      hashBlocks: box.querySelector(".vul-hash-blocks").value.trim(),
      hashAuthor: box.querySelector(".vul-hash-author").value.trim(),
      hashText: box.querySelector(".vul-hash-text").value.trim()
    });
    for (const sel of [".vul-hash-blocks", ".vul-hash-author", ".vul-hash-text"]) {
      box.querySelector(sel).addEventListener("change", saveBars);
    }
    const handle = box.querySelector(".vul-hash-resize");
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, sw = box.offsetWidth, sh = box.offsetHeight;
      const move = (ev) => {
        const w = Math.max(180, sw + ev.clientX - sx);
        const h = Math.max(48, sh + ev.clientY - sy);
        box.style.width = w + "px";
        box.style.height = h + "px";
        box.dataset.h = h + "px";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        saveLayout();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    return box;
  }

  function applyVisibility() {
    const el = ensureBox();
    if (!el.isConnected) (document.documentElement || document.body).appendChild(el);
    if (overlayOn) {
      el.style.setProperty("display", "block", "important");
      el.style.setProperty("visibility", "visible", "important");
      el.style.setProperty("opacity", "1", "important");
    } else {
      el.style.setProperty("display", "none", "important");
    }
  }

  function roll(item) {
    if (!overlayOn) return;
    const el = ensureBox();
    const body = el.querySelector(".vul-hash-body");
    const line = document.createElement("div");
    line.style.margin = "0 0 6px";
    const head = document.createElement("span");
    head.style.fontWeight = "700";
    if (item.isNew) {
      head.style.color = "#00ff00";
      head.textContent = "NEW: ";
      line.appendChild(head);
      line.appendChild(document.createTextNode((item.author || "") + " " + twoLines(item.text)));
    } else {
      head.style.color = "#ff0000";
      head.textContent = "ALREADY: ";
      line.appendChild(head);
      line.appendChild(document.createTextNode((item.author || "") + " : " + stamp(item.createdAt) + " : " + (item.title || "") + " " + (item.url || "") + " : " + twoLines(item.text)));
    }
    body.appendChild(line);
    while (body.childElementCount > 12) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  }

  function showWelcomeOnce() {
    if (!overlayOn) return;
    const el = ensureBox();
    const body = el.querySelector(".vul-hash-body");
    if (!body || body.dataset.welcomed) return;
    body.dataset.welcomed = "1";
    const line = document.createElement("div");
    line.style.cssText = "margin:0 0 6px;color:#8fffa0;font-weight:700;";
    line.textContent = "WELCOME — content2.js alive — " + stamp(Date.now());
    body.appendChild(line);
  }

  chrome.storage.local.get({
    showHashOverlay: false,
    hashBlocks: "ytd-comment-view-model ytd-backstage-post-renderer",
    hashAuthor: "#author-text",
    hashText: "yt-attributed-string#content-text yt-formatted-string#content-text",
    [LAYOUT_KEY]: null
  }).then((bag) => {
    overlayOn = !!bag.showHashOverlay;
    const el = ensureBox();
    applyVisibility();
    const blocks = el.querySelector(".vul-hash-blocks");
    const author = el.querySelector(".vul-hash-author");
    const text = el.querySelector(".vul-hash-text");
    if (blocks) blocks.value = bag.hashBlocks || "";
    if (author) author.value = bag.hashAuthor || "";
    if (text) text.value = bag.hashText || "";
    const layout = bag[LAYOUT_KEY];
    if (layout && layout.left >= 0 && layout.top >= 0 && layout.left < 2000 && layout.top < 1200) {
      el.style.left = layout.left + "px";
      el.style.top = layout.top + "px";
      el.style.width = Math.max(280, layout.width || 520) + "px";
      el.style.height = Math.max(180, layout.height || 280) + "px";
      el.dataset.h = Math.max(180, layout.height || 280) + "px";
    }
    folded = false;
    applyVisibility();
    showWelcomeOnce();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.showHashOverlay) return;
    overlayOn = !!changes.showHashOverlay.newValue;
    applyVisibility();
    if (overlayOn) showWelcomeOnce();
  });

  const shown = new Set();
  let timer = null;
  function flushHash() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const bag = await chrome.storage.local.get({
        logHash: false,
        showHashOverlay: false,
        hashBlocks: "ytd-comment-view-model ytd-backstage-post-renderer",
        hashAuthor: "#author-text",
        hashText: "yt-attributed-string#content-text yt-formatted-string#content-text"
      });
      if (!bag.logHash && !overlayOn) return;
      const live = document.getElementById("vul-hash-overlay") || ensureBox();
      const selectors = String(live.querySelector(".vul-hash-blocks").value || bag.hashBlocks || "").split(/\s+/).filter(Boolean);
      const authorSel = String(live.querySelector(".vul-hash-author").value || bag.hashAuthor || "#author-text").trim();
      const textSels = String(live.querySelector(".vul-hash-text").value || bag.hashText || "").split(/\s+/).filter(Boolean);
      const batch = collectHashBlocks(selectors, authorSel, textSels);
      if (!batch.length) return;
      if (!bag.logHash) {
        for (const row of batch) {
          if (shown.has(row.hashKey)) continue;
          shown.add(row.hashKey);
          roll({ ...row, isNew: true, createdAt: Date.now(), title: document.title, url: location.href });
        }
        return;
      }
      chrome.runtime.sendMessage({ type: "yt-hash", batch }, (res) => {
        if (chrome.runtime.lastError || !res || !res.results) return;
        for (const item of res.results) {
          if (!item.hashKey || shown.has(item.hashKey)) continue;
          shown.add(item.hashKey);
          roll(item);
        }
      });
    }, 200);
  }

  const obs = new MutationObserver(flushHash);
  function arm() {
    if (!document.body) return;
    obs.disconnect();
    obs.observe(document.body, { childList: true, subtree: true });
    flushHash();
  }
  document.addEventListener("yt-navigate-finish", arm);
  window.addEventListener("load", arm);
  if (document.readyState === "complete") arm();
  setInterval(flushHash, 1000);
  setInterval(() => {
    if (!overlayOn) return;
    const el = document.getElementById("vul-hash-overlay");
    if (el && el.isConnected && el.style.display !== "none") return;
    applyVisibility();
  }, 1000);
})();
