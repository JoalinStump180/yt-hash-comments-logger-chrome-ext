Load unpacked in Chrome or Edge
--------------------------------
1. Open edge://extensions or chrome://extensions
2. Turn on Developer mode
3. Load unpacked
4. Select this folder: visit-url-logger

The background worker logs main-frame navigations.

YouTube rule
------------
These two visits become one stored URL:

https://www.youtube.com/watch?v=<YOUTUBEVIDEOID>&t=45s&todaydate=20260928$$
https://www.youtube.com/watch?v=<YOUTUBEVIDEOID>&t=132s&todaydate=20260928$$

stored as:

https://www.youtube.com/watch?v=<YOUTUBEVIDEOID>&todaydate=20260928$$

&t= is dropped. v and todaydate are kept.
If todaydate is missing, the logger adds today's date as YYYYMMDD$$.

Same canonical URL is not inserted again.
Same video on another day is a new row.

Note
----
This extension's IndexedDB is NOT the same database as a file:// explorer page.
Use the extension popup to see what the logger saved.

Fix applied
-----------
The Explorer JavaScript was moved from an inline <script> in explorer.html
to explorer.js. Chrome Manifest V3 extension pages block inline JavaScript
under the extension page Content Security Policy, which caused the Explorer
UI to appear without loading/rendering the IndexedDB records.

Also fixed JSON import so an imported record's title is preserved.





Known issue and fix logs:  

20261020:  


if (!db.objectStoreNames.contains(HASH_TEXT_STORE)) {     const texts = db.createObjectStore(HASH_TEXT_STORE, { keyPath: "hashKey" });     texts.createIndex("byPageId", "pageId");     texts.createIndex("byCreatedAt", "createdAt");   }   if (!db.objectStoreNames.contains(HASH_PAGE_STORE)) {     db.createObjectStore(HASH_PAGE_STORE, { keyPath: "pageId" });   }           ---- i dirty fix that by move this 2 block from db2.js to db.js ]



i found the problem is :if i do not move these 2 block form db2 to db.js  , then    if i click in the pop menu , in an offline page , the hashKey and pageID DB will fails to be created ; but if  i click in the pop menu , in an 'online' page  , say google.com , the hashKey and pageID DB can  to be created ---why  ?

The popup page loads db.js and not db2.js. upgradeHashStores only exists where db2.js has been loaded.
db.js does not create the hash stores itself. It only calls them if the function is already there:
JavaScriptif (typeof upgradeHashStores === "function") upgradeHashStores(db);
Popup on an offline page. The popup is the one that calls openDb(). Its scripts are db.js then popup.js. db2.js was never loaded, so upgradeHashStores is undefined. The if is false. records and comments are created. hashTexts and hashPages are not.
Popup on google.com. That page woke the service worker. background.js starts with importScripts("db.js", "db2.js"), so upgradeHashStores exists there. A navigation or a message makes the worker call openDb() first. The upgrade runs in the worker, and the two hash stores are created. By the time the popup opens, they already exist.
Moving the two blocks into db.js works because the popup then creates them itself, with no need for db2.js or a live page. The other fix is to add <script src="db2.js"></script> before db.js in popup.html, and the same in explorer.html if it is not already there.
