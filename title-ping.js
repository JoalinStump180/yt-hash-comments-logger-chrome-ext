let lastUrl = "";
let lastTitle = "";

let lastSent = "lastsent";
function pingTitle() {
  const title = String(document.title || "").trim();
  const url = String(location.href || "");
  if (!url || !title) return;
  //const sig = url + "\n" + title;
  //if (sig === lastSent) return;
  //lastSent = sig;
  if (url !== lastUrl && title === lastTitle) return;
  if (url === lastUrl && title === lastTitle) return;
  lastUrl = url;
  lastTitle = title;

  
  //chrome.runtime.sendMessage({ type: "page-title",  url:`${url}suffixnospace`, title }).catch(() => {});
  
  
  
   
  
  chrome.runtime.sendMessage({ type: "page-title2", url:`${url}`, title }).catch(() => {});
  
  
  
  
    //chrome.runtime.sendMessage({ type: "page-title",  url:`${url}pagetitle11`, title }).catch(() => {});
  //chrome.runtime.sendMessage({ type: "page-title",  url:`${url} pagetitle12 with space`, title }).catch(() => {});
  //chrome.runtime.sendMessage({ type: "page-title",  url:`prefixnospace${url}`, title }).catch(() => {}); 
  // chrome.runtime.sendMessage({ type: "page-title2", url:`${url}pagetitle21nospace`, title }).catch(() => {});   ---if the pagetitle21nospace appear as suffix, this can works
  
  //now only "pagetilte21 with space "  and  "pagetilte23 with space " works;  the pagetitle21nospace  pagetitle23nospace dose not work.  why   ? ---FIXED:   do not use alert () in background.js
  
  //chrome.runtime.sendMessage({ type: "page-title2", url:`"pagetitle2.2"+  ${url}`, title }).catch(() => {});  --- this is tested, ok. because inbetween the +  and $ , there is a space char . 
  //chrome.runtime.sendMessage({ type: "page-title2", url:"pagetitle23nospace" +  url, title }).catch(() => {});
  //chrome.runtime.sendMessage({ type: "page-title2", url:"pagetitle23 with space " +  url, title }).catch(() => {}); --- this is tested, ok
}
pingTitle();
setInterval(pingTitle, 2100);
document.addEventListener("yt-navigate-finish", pingTitle);
window.addEventListener("yt-page-data-updated", pingTitle);
