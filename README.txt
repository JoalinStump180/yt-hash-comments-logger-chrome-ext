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
