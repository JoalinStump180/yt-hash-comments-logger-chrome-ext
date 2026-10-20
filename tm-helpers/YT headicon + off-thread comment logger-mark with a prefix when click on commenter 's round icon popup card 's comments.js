// ==UserScript==
// @name         YT headicon + off-thread comment logger
// @namespace    local
// @version      0.2.0
// @description  headiconclick = comment under clicked avatar. profilecard = comment-like text not inside ytd-comments
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const PREFIX_CLICK = "headiconclick";
  const PREFIX_CARD = "profilecard";

  function clip(s, n) {
    return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  }

  function inWatchFlexy(el) {
    return !!(el && el.closest && el.closest("ytd-watch-flexy"));
  }
  function inEngagementPanel(el) {
    return !!(el && el.closest && el.closest("ytd-engagement-panel-section-list-renderer"));
  }
  function inMainComments(el) {
    return inWatchFlexy(el) || inEngagementPanel(el);
  }

  function commentRoot(el) {
    return (
      el.closest("ytd-comment-view-model") ||
      el.closest("yt-comment-view-model") ||
      el.closest("ytd-comment-renderer") ||
      el.closest("ytd-comment-thread-renderer")
    );
  }

  function commentText(root) {
    const node =
      root.querySelector("#content-text") ||
      root.querySelector("#content-text yt-attributed-string") ||
      root.querySelector("yt-attributed-string") ||
      root.querySelector("#comment-content") ||
      root.querySelector("#content");
    return (node?.innerText || root.innerText || "").trim();
  }

  function authorOf(root) {
    const a =
      root.querySelector("#author-text") ||
      root.querySelector("a#author-text") ||
      root.querySelector("#author-name") ||
      root.querySelector('a[href*="/@"]');
    const href = a?.getAttribute("href") || "";
    const handle = (href.match(/\/@([\w.-]+)/) || [])[1];
    const name = (a?.innerText || "").trim();
    return handle ? "@" + handle : name;
  }

  function isHeadIcon(el) {
    if (!el || !el.closest) return false;
    return !!(
      el.closest("#author-thumbnail") ||
      el.closest("#author-photo") ||
      el.closest("a#author-thumbnail") ||
      el.closest("yt-img-shadow") ||
      el.closest("yt-icon-shape")
    );
  }

  let box;
  function overlay() {
    if (box && box.isConnected) return box;
    box = document.createElement("div");
    box.id = "tm-yt-headicon-log";
    box.style.cssText =
      "position:fixed;right:12px;bottom:12px;width:520px;max-height:70vh;overflow:auto;z-index:2147483647;pointer-events:none;background:rgba(0,0,0,.4);color:#d7ffd7;font:13px/1.4 Consolas,Segoe UI,sans-serif;padding:10px 12px;border-radius:8px;";
    (document.documentElement || document.body).appendChild(box);
    return box;
  }

  const seen = new Set();
  function roll(prefix, text) {
    const body = clip(text, 900);
    if (!body) return;
    const sig = prefix + "|" + body.slice(0, 180);
    if (seen.has(sig)) return;
    seen.add(sig);
    if (seen.size > 80) seen.clear();
    const line = document.createElement("div");
    line.style.margin = "0 0 6px";
    line.style.whiteSpace = "pre-wrap";
    line.textContent = prefix + "  " + body;
    const el = overlay();
    el.appendChild(line);
    while (el.childElementCount > 10) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
    console.log("[yt-headicon]", prefix, text);
  }

  document.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      if (!isHeadIcon(t)) return;
      const unit = commentRoot(t);
      if (!unit) return;
      if (!inWatchFlexy(unit)) return;
      const who = authorOf(unit);
      const text = commentText(unit);
      if (!text) return;
      roll(
        PREFIX_CLICK,
        (who ? who + "  " : "") + clip(text, 50) + (text.length > 50 ? "бн" : "") + "\n" + text
      );
    },
    true
  );

  function scrapeOutsideComments() {
    const cards = document.querySelectorAll(
      "yt-profile-card-view-model, yt-dialog-view-model, tp-yt-paper-dialog, yt-sheet-view-model"
    );
    cards.forEach((card) => {
      if (inMainComments(card)) return;
      const raw = (card.innerText || "").trim();
      if (!raw) return;
      if (!/Commented on|Recent comments/i.test(raw) && raw.length < 40) return;
      const parts = raw.split(/\n(?=Commented on)/i);
      parts.forEach((p) => {
        const s = p.trim();
        if (s) roll(PREFIX_CARD, s);
      });
    });

    document.querySelectorAll("ytd-comment-view-model, yt-comment-view-model, ytd-comment-renderer").forEach((el) => {
      if (inMainComments(el)) return;
      const text = commentText(el);
      if (text.length < 8) return;
      roll(PREFIX_CARD, (authorOf(el) ? authorOf(el) + "  " : "") + text);
    });
  }

  const mo = new MutationObserver(() => {
    clearTimeout(scrapeOutsideComments.t);
    scrapeOutsideComments.t = setTimeout(scrapeOutsideComments, 150);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scrapeOutsideComments, 1600);
})();
