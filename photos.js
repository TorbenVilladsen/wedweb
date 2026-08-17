/* =========================================================================
   GÆSTEBILLEDER — upload + galleri
   -------------------------------------------------------------------------
   Shared by /Galleri/ (behind the normal ?uid= gate) and /admin/ (behind a
   real login). Each page just drops in the mount points and calls
   WedPhotos.init(); everything below builds the UI itself so the pages can
   never drift apart.

   Uploading requires an invitation: there is no open, ungated entry point,
   so guests arrive through their own personal link and nothing else.

   Talks straight to Supabase from the browser — there is no server. Note
   that unlike the Google Apps Script calls in RSVP/index.html we do NOT use
   mode:"no-cors" here: Supabase sends real CORS headers, and real status
   codes are what make the retry logic and the honest error messages work.

   Two kinds of delete:
     * a guest may hide a photo they uploaded themselves. Proof is a random
       token generated at upload time, kept in that phone's localStorage and
       checked server-side by the delete_own_photo() function. The photo
       vanishes from the gallery; the file stays until an admin purges it.
     * a signed-in admin may delete anything, files and all.
   ========================================================================= */

(function () {
    "use strict";

    // --- CONFIGURATION -----------------------------------------------------
    // Paste the two values from Supabase → Project Settings → API here.
    // See docs/supabase.md for the full walkthrough.
    const CONFIG = {
        SUPABASE_URL: "https://bpyjzpxnqzjiwzzshscs.supabase.co",
        SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJweWp6cHhucXpqaXd6enNoc2NzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1MTkzNjQsImV4cCI6MjEwMTA5NTM2NH0.U2nI-zx-YgpFb9WQlDSuFw2rmyBGxEsEo2WviBF3lYc",

        BUCKET: "gallery",
        DAY_FOLDER: "uploads/2026-08-15",

        // Speeches and entertainment live in their own bucket, written only by
        // tools/import_video.py with the service_role key. Keeping them apart
        // is what lets `gallery` stay capped at 10 MB and image/jpeg: that cap
        // is the one guest-upload limit a browser cannot argue with, and a
        // bucket big enough for video would also accept a 2 GB file named
        // ".jpg". Nothing here is uploaded from a browser, ever.
        VIDEO_BUCKET: "video",

        // /test/ writes here instead, so trying the flow on a borrowed phone
        // never puts a picture of a keyboard in the real wedding gallery. Both
        // live under uploads/, so the same storage policy covers them and no
        // Supabase change is needed.
        TEST_FOLDER: "uploads/test",

        // Where guests send video. The site is images only — a video cannot be
        // downscaled in the browser the way a photo can, so it would go up at
        // full size and could still be unplayable for half the guests.
        VIDEO_EMAIL: "torben-v@hotmail.com",

        // When the gallery opened. This used to be kept in step with the
        // front-page countdown, but that countdown has moved on to the copper
        // anniversary in 2039 — this one must stay on the wedding day. Push it
        // forward to match script.js again and the gallery locks itself shut.
        // Parsed as local time.
        OPENS_AT: "August 15, 2026 13:00:00",

        MAX_EDGE: 2560,      // longest edge of the stored photo (prints fine at 8x10")
        JPEG_Q: 0.82,
        THUMB_EDGE: 480,
        THUMB_Q: 0.7,

        // Rows are tiny and the images below them are lazy, so a bigger page
        // costs almost nothing — but it halves the number of round trips
        // needed to scroll through several thousand of the photographer's.
        PAGE_SIZE: 96,
        CONCURRENCY: 2,      // parallel uploads; decoding is always serial
        TIMEOUT_MS: 60000,
        RETRY_DELAYS: [1000, 3000, 8000]
    };

    const ORPHAN_KEY = "wed_orphans";
    const MINE_KEY = "wed_my_photos";      // { photoId: deleteToken }
    const ADMIN_KEY = "wed_admin_session";
    const PREVIEW_KEY = "wed_preview";

    // --- SMALL HELPERS -----------------------------------------------------

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function uuid() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        // Fallback for older browsers — only needs to be collision-free, not secure.
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
    }

    // A delete token has to be unguessable, unlike the filename UUIDs.
    function secret() {
        if (window.crypto && crypto.getRandomValues) {
            const bytes = new Uint8Array(24);
            crypto.getRandomValues(bytes);
            return Array.prototype.map.call(bytes, function (b) {
                return ("0" + b.toString(16)).slice(-2);
            }).join("");
        }
        return uuid() + uuid();
    }

    function readStore(key, fallback) {
        try {
            return JSON.parse(localStorage.getItem(key)) || fallback;
        } catch (err) {
            return fallback;
        }
    }

    function writeStore(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (err) {
            /* private mode or full — the feature degrades, nothing breaks */
        }
    }

    function isConfigured() {
        return CONFIG.SUPABASE_URL.indexOf("DIT-PROJEKT") === -1 &&
            CONFIG.SUPABASE_ANON_KEY.indexOf("DIN_ANON_KEY") === -1;
    }

    // Videos and their poster frames sit in a different bucket from the
    // photos, so every URL needs to know which kind of row it came from.
    // Defaulting to the photo bucket keeps every existing call site correct.
    function bucketFor(kind) {
        return kind === "video" ? CONFIG.VIDEO_BUCKET : CONFIG.BUCKET;
    }

    function publicUrl(path, kind) {
        return CONFIG.SUPABASE_URL + "/storage/v1/object/public/" +
            bucketFor(kind) + "/" + path;
    }

    // ?download= makes Supabase send Content-Disposition: attachment, which is
    // what actually saves the file — the <a download> attribute is ignored
    // cross-origin.
    function downloadUrl(photo) {
        // Guests browse the 2560 px version, but downloading should hand over
        // the photographer's untouched file where there is one. Guest uploads
        // have no original_path: the browser already downscaled before sending,
        // so storage_path IS the best copy that exists.
        const path = photo.original_path || photo.storage_path;
        const dot = path.lastIndexOf(".");
        const ext = dot > -1 ? path.slice(dot) : (photo.kind === "video" ? ".mp4" : ".jpg");

        // Ten files called bryllup-…-a1b2c3d4.mp4 in a downloads folder tell
        // you nothing, so a video is named after its title where it has one.
        const label = photo.kind === "video" && photo.title
            ? slug(photo.title)
            : String(photo.id || "").slice(0, 8);

        const name = "bryllup-15-08-2026-" + label + ext;
        return publicUrl(path, photo.kind) + "?download=" + encodeURIComponent(name);
    }

    // --- SAVING TO THE PHONE'S PHOTO LIBRARY -------------------------------
    // A web page cannot write to iOS Billeder or the Android gallery. There is
    // no API for it, on either platform, and a plain download lands in Filer /
    // Downloads instead — where nobody goes looking for a wedding photo.
    //
    // The share sheet is the only way in. We hand the OS the actual file and
    // it offers "Gem billede" / "Gem video", which writes to the photo library
    // proper. One extra tap, but the picture ends up where people expect.
    //
    // Gated on touch: on a desktop the share sheet is a worse Download button,
    // so those keep the plain link.
    function canSaveToLibrary() {
        return !!(navigator.share && navigator.canShare &&
            (navigator.maxTouchPoints || 0) > 0);
    }

    // iOS has a shortcut nothing else does: long-press a photo and "Føj til
    // Billeder" writes it straight to the camera roll — no share sheet, no
    // waiting for a download. It works here already (nothing in the CSS blocks
    // the callout, and the swipe handlers are passive), it is just invisible
    // unless you happen to know. Worth one line of text.
    //
    // iPadOS reports itself as a Mac, hence the second half.
    function isIOS() {
        return /iP(hone|ad|od)/.test(navigator.userAgent) ||
            (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
    }

    // Sharing means holding the whole file in memory first. A 2 MB photo is
    // nothing; a ten-minute speech is not, and buffering that on a phone over
    // mobile data — with no progress bar, because the share sheet has not
    // opened yet — fails badly. Above this we leave it as a normal download.
    const MAX_SHARE_BYTES = 100 * 1024 * 1024;

    // mm:ss, so a tile can say how long the speech is before anyone commits to
    // it on mobile data.
    function runtime(seconds) {
        const s = Math.max(0, Math.round(seconds || 0));
        return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }

    function slug(text) {
        return String(text)
            .toLowerCase()
            .replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "video";
    }

    // Errors carry a `retryable` flag so the retry loop never hammers away at
    // something that will fail identically every time (e.g. a rejected format).
    function netError(message) {
        const e = new Error(message || "network");
        e.retryable = true;
        return e;
    }

    function httpError(status, body) {
        const e = new Error("http " + status + (body ? ": " + body : ""));
        e.status = status;
        e.retryable = status >= 500 || status === 429;
        return e;
    }

    async function withRetry(fn) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn();
            } catch (err) {
                if (!err.retryable || attempt >= CONFIG.RETRY_DELAYS.length) throw err;
                // Jitter keeps 80 phones from retrying in lockstep after a wifi blip.
                await sleep(CONFIG.RETRY_DELAYS[attempt] + Math.random() * 500);
            }
        }
    }

    // --- ADMIN SESSION -----------------------------------------------------
    // Ordinary Supabase email+password auth. Signups are disabled in the
    // dashboard, so "authenticated" means the couple and nobody else.

    let session = readStore(ADMIN_KEY, null);

    function isAdmin() {
        return !!(session && session.access_token);
    }

    // Whether the stored token is still worth sending. Supabase access tokens
    // last about an hour, and an EXPIRED one is worse than none at all:
    // PostgREST answers 401, and the gallery tells the visitor the photos
    // could not be fetched. It only ever bit us — a guest never signs in — but
    // logging into /admin/ once was enough to break /Galleri/ on that browser
    // an hour later, until the site data was cleared.
    function sessionFresh() {
        return !!(session && session.access_token && session.expires_at &&
            (session.expires_at * 1000) > Date.now() + 60000);
    }

    function anonHeaders() {
        return {
            apikey: CONFIG.SUPABASE_ANON_KEY,
            Authorization: "Bearer " + CONFIG.SUPABASE_ANON_KEY
        };
    }

    // Reads and deletes run as the admin when signed in, as anon otherwise.
    // Uploads always use anonHeaders(), because the insert policies are
    // written for the anon role.
    function authHeaders() {
        return {
            apikey: CONFIG.SUPABASE_ANON_KEY,
            Authorization: "Bearer " + (sessionFresh() ? session.access_token : CONFIG.SUPABASE_ANON_KEY)
        };
    }

    function setSession(data) {
        session = data
            ? {
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                expires_at: data.expires_at || (Math.floor(Date.now() / 1000) + (data.expires_in || 3600)),
                email: (data.user && data.user.email) || (session && session.email) || ""
            }
            : null;

        if (session) writeStore(ADMIN_KEY, session);
        else {
            try { localStorage.removeItem(ADMIN_KEY); } catch (err) { /* ignore */ }
        }
    }

    async function signIn(email, password) {
        const res = await fetch(CONFIG.SUPABASE_URL + "/auth/v1/token?grant_type=password", {
            method: "POST",
            headers: { apikey: CONFIG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ email: email, password: password })
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
            const e = new Error(data.error_description || data.msg || data.message || "login");
            e.status = res.status;
            throw e;
        }
        setSession(data);
        return session;
    }

    async function refreshSession() {
        if (!session || !session.refresh_token) return false;
        try {
            const res = await fetch(CONFIG.SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
                method: "POST",
                headers: { apikey: CONFIG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
                body: JSON.stringify({ refresh_token: session.refresh_token })
            });
            if (!res.ok) {
                setSession(null);
                return false;
            }
            setSession(await res.json());
            return true;
        } catch (err) {
            return false; // offline: keep the session and try again later
        }
    }

    async function ensureSession() {
        if (!isAdmin()) return false;
        if (sessionFresh()) return true;
        return await refreshSession();
    }

    async function signOut() {
        const token = session && session.access_token;
        setSession(null);
        if (!token) return;
        try {
            await fetch(CONFIG.SUPABASE_URL + "/auth/v1/logout", {
                method: "POST",
                headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: "Bearer " + token }
            });
        } catch (err) {
            /* the local session is already gone, which is what matters */
        }
    }

    // --- "MY PHOTOS" -------------------------------------------------------
    // The only thing that can identify a guest without an account: a token
    // written to this browser when the photo was uploaded.

    // Kept in memory and written back on a short delay. Doing a full
    // JSON.parse + JSON.stringify of the whole map on every single upload is
    // quadratic: by the 500th photo each save is re-serialising everything that
    // came before it.
    let mineCache = null;
    let mineTimer = null;

    function myPhotos() {
        if (!mineCache) mineCache = readStore(MINE_KEY, {});
        return mineCache;
    }

    function flushMine() {
        if (mineTimer) {
            clearTimeout(mineTimer);
            mineTimer = null;
        }
        if (mineCache) writeStore(MINE_KEY, mineCache);
    }

    function scheduleMineWrite() {
        if (mineTimer) return;
        mineTimer = setTimeout(function () {
            mineTimer = null;
            flushMine();
        }, 400);
    }

    function rememberMine(id, token) {
        myPhotos()[id] = token;
        scheduleMineWrite();
    }

    function forgetMine(id) {
        delete myPhotos()[id];
        scheduleMineWrite();
    }

    // Losing a delete token means a guest can no longer remove their own photo,
    // so make sure a pending write survives the page going away.
    window.addEventListener("pagehide", flushMine);

    // Another tab of the same site has its own cache; without this, uploading in
    // one tab and deleting in another would look like the token never existed.
    window.addEventListener("storage", function (e) {
        if (e.key === MINE_KEY) mineCache = null;
    });

    function tokenFor(id) {
        return myPhotos()[id] || null;
    }

    // --- IMAGE PIPELINE ----------------------------------------------------
    // Decoding a 12 MP image is memory-heavy, so only one runs at a time no
    // matter how many uploads are in flight — doing several at once is what
    // kills the tab on an older phone.

    let decodeChain = Promise.resolve();

    function serialise(fn) {
        const run = decodeChain.then(fn, fn);
        decodeChain = run.then(function () { }, function () { });
        return run;
    }

    async function decodeImage(file) {
        if (typeof createImageBitmap === "function") {
            try {
                // `from-image` applies EXIF rotation, so width/height come back
                // already oriented and we never have to rotate by hand.
                return await createImageBitmap(file, { imageOrientation: "from-image" });
            } catch (err) {
                // Either the options bag is unsupported or the codec is (HEIC on
                // Android). Fall through to the <img> path, which handles the
                // former and fails cleanly on the latter.
            }
        }

        return await new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = function () {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = function () {
                URL.revokeObjectURL(url);
                const e = new Error("decode");
                e.code = "DECODE";
                reject(e);
            };
            img.src = url;
        });
    }

    // Halve repeatedly before the final draw. A single drawImage from 4032px
    // straight down to 480px aliases badly; stepping keeps thumbnails clean.
    function scaleToCanvas(source, maxEdge) {
        let current = source;
        let w = source.width || source.naturalWidth;
        let h = source.height || source.naturalHeight;

        while (Math.max(w, h) / 2 > maxEdge) {
            const nw = Math.max(1, Math.round(w / 2));
            const nh = Math.max(1, Math.round(h / 2));
            const step = document.createElement("canvas");
            step.width = nw;
            step.height = nh;
            const stepCtx = step.getContext("2d");
            stepCtx.imageSmoothingQuality = "high";
            stepCtx.drawImage(current, 0, 0, nw, nh);
            current = step;
            w = nw;
            h = nh;
        }

        const ratio = Math.min(1, maxEdge / Math.max(w, h));
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(w * ratio));
        out.height = Math.max(1, Math.round(h * ratio));
        const ctx = out.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(current, 0, 0, out.width, out.height);
        return out;
    }

    function canvasToBlob(canvas, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(function (blob) {
                if (blob) resolve(blob);
                else reject(new Error("encode"));
            }, "image/jpeg", quality);
        });
    }

    async function processImage(file) {
        const bitmap = await decodeImage(file);
        try {
            const fullCanvas = scaleToCanvas(bitmap, CONFIG.MAX_EDGE);
            const thumbCanvas = scaleToCanvas(fullCanvas, CONFIG.THUMB_EDGE);

            const full = await canvasToBlob(fullCanvas, CONFIG.JPEG_Q);
            const thumb = await canvasToBlob(thumbCanvas, CONFIG.THUMB_Q);

            return {
                full: full,
                thumb: thumb,
                width: fullCanvas.width,
                height: fullCanvas.height
            };
        } finally {
            if (bitmap.close) bitmap.close();
        }
    }

    // --- NETWORK -----------------------------------------------------------

    function uploadBlob(path, blob, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", CONFIG.SUPABASE_URL + "/storage/v1/object/" + CONFIG.BUCKET + "/" + path, true);
            xhr.setRequestHeader("apikey", CONFIG.SUPABASE_ANON_KEY);
            xhr.setRequestHeader("Authorization", "Bearer " + CONFIG.SUPABASE_ANON_KEY);
            xhr.setRequestHeader("Content-Type", "image/jpeg");
            // Filenames are UUIDs, so every object really is immutable.
            xhr.setRequestHeader("Cache-Control", "public, max-age=31536000, immutable");
            xhr.setRequestHeader("x-upsert", "false");
            xhr.timeout = CONFIG.TIMEOUT_MS;

            if (onProgress) {
                xhr.upload.onprogress = function (e) {
                    if (e.lengthComputable) onProgress(e.loaded / e.total);
                };
            }

            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) resolve();
                else reject(httpError(xhr.status, xhr.responseText));
            };
            xhr.onerror = function () { reject(netError()); };
            xhr.ontimeout = function () { reject(netError("timeout")); };

            xhr.send(blob);
        });
    }

    async function insertRow(row) {
        let res;
        try {
            res = await fetch(CONFIG.SUPABASE_URL + "/rest/v1/photos", {
                method: "POST",
                headers: Object.assign(anonHeaders(), {
                    "Content-Type": "application/json",
                    Prefer: "return=minimal"
                }),
                body: JSON.stringify(row)
            });
        } catch (err) {
            throw netError();
        }
        if (!res.ok) throw httpError(res.status, await res.text().catch(function () { return ""; }));
    }

    const BASE_COLUMNS = "id,storage_path,thumb_path,guest_name,width,height,seq,deleted_at";

    // Added by the 4c/4d migration. If the site is deployed before that SQL has
    // been run, PostgREST answers 400 "column does not exist" — which would take
    // the whole gallery down over a download link. So ask for them, and if they
    // are not there yet, drop them once and carry on without.
    const EXTRA_COLUMNS = "source,original_path";
    let extraColumns = true;

    // The video migration (4e) is a separate step, run much later than 4c/4d.
    // Keeping it a separate tier matters: lump them together and a project
    // that has run 4c/4d but not 4e would drop `original_path` too, quietly
    // handing out the 2560 px copy where the photographer's original exists.
    const VIDEO_COLUMNS = "kind,duration_s,title";
    let videoColumns = true;

    function selectList() {
        return BASE_COLUMNS +
            (extraColumns ? "," + EXTRA_COLUMNS : "") +
            (videoColumns ? "," + VIDEO_COLUMNS : "");
    }

    /**
     * @param {string} [folder] restrict to one upload folder. Keeps the real
     *        gallery and the /test/ gallery from seeing each other's photos.
     *        Omit for admin, which needs to see everything to clean up.
     * @param {{source?: string, kind?: string, guestName?: string}} [filter]
     *        what the gallery is showing. `source` picks guest vs
     *        photographer, `kind` picks the videos, `guestName` picks one
     *        person. Omit for "Alle".
     */
    async function fetchPage(beforeSeq, wantCount, includeDeleted, folder, filter) {
        function buildUrl() {
            let url = CONFIG.SUPABASE_URL + "/rest/v1/photos" +
                "?select=" + selectList() +
                "&order=seq.desc&limit=" + CONFIG.PAGE_SIZE;
            if (!includeDeleted) url += "&deleted_at=is.null";
            if (beforeSeq != null) url += "&seq=lt." + beforeSeq;
            // PostgREST turns * into the SQL % wildcard.
            if (folder) url += "&storage_path=like." + encodeURIComponent(folder + "/*");
            // Filtering on a column the migration has not created yet would
            // 400 the whole page, so each filter waits for its own tier.
            if (filter && filter.source && extraColumns) {
                url += "&source=eq." + encodeURIComponent(filter.source);
            }
            if (filter && filter.kind && videoColumns) {
                url += "&kind=eq." + encodeURIComponent(filter.kind);
            }
            // guest_name is a base column, so this one needs no migration and
            // no tier guard. Plain percent-encoding is also the right escaping:
            // PostgREST keeps double quotes as part of the value for eq., so
            // quoting "Cecilie" looks for a name spelled with the quotes. A
            // comma is not a delimiter here either — eq. takes one value.
            if (filter && filter.guestName) {
                url += "&guest_name=eq." + encodeURIComponent(filter.guestName);
            }
            return url;
        }

        const headers = authHeaders();
        if (wantCount) headers.Prefer = "count=exact";

        // A token can still be refused after passing sessionFresh(): revoked
        // server-side, or this device's clock is off. Reading the gallery needs
        // no privileges whatsoever, so recover as anon instead of telling the
        // visitor the photos are unavailable.
        async function send() {
            const first = await fetch(buildUrl(), { headers: headers });
            if (first.status !== 401 || !isAdmin()) return first;

            if (await refreshSession()) Object.assign(headers, authHeaders());
            else Object.assign(headers, anonHeaders());
            return await fetch(buildUrl(), { headers: headers });
        }

        let res;
        try {
            res = await send();
            // PostgREST does not say WHICH column it did not recognise, so
            // give up the newest migration first and only fall back further if
            // that was not the problem. At most two extra round trips, once.
            while (res.status === 400 && (videoColumns || extraColumns)) {
                if (videoColumns) videoColumns = false;
                else extraColumns = false;
                res = await send();
            }
        } catch (err) {
            throw netError();
        }
        if (!res.ok) throw httpError(res.status);

        let total = null;
        const range = res.headers.get("content-range"); // e.g. "0-47/327"
        if (range && range.indexOf("/") !== -1) {
            const parsed = parseInt(range.split("/")[1], 10);
            if (!isNaN(parsed)) total = parsed;
        }

        return { rows: await res.json(), total: total };
    }

    /**
     * How many rows match one filter. Used only to decide whether the filter
     * buttons are worth showing at all — before the photographer's import, and
     * before the videos are uploaded, there is nothing to filter, and a tab
     * that always comes back empty is worse than no tab.
     * @param {{source?: string, kind?: string}} filter
     * @returns {Promise<number>} 0 when the column does not exist yet.
     */
    async function countMatching(filter) {
        let url = CONFIG.SUPABASE_URL + "/rest/v1/photos?select=id&limit=1" +
            "&deleted_at=is.null";
        if (filter.source) url += "&source=eq." + encodeURIComponent(filter.source);
        if (filter.kind) url += "&kind=eq." + encodeURIComponent(filter.kind);
        const headers = authHeaders();
        headers.Prefer = "count=exact";
        headers.Range = "0-0";
        try {
            const res = await fetch(url, { headers: headers });
            if (!res.ok) return 0;
            const range = res.headers.get("content-range");
            if (!range || range.indexOf("/") === -1) return 0;
            const parsed = parseInt(range.split("/")[1], 10);
            return isNaN(parsed) ? 0 : parsed;
        } catch (err) {
            return 0;
        }
    }

    /**
     * Everyone who has put their name to a photo, with how many they sent.
     *
     * There is no DISTINCT in PostgREST and no view to lean on, so we ask for
     * the one column and fold it here. That is deliberate: guest_name is a
     * base column, granted to anon since the very first migration, so the
     * people filter works on the live project today — no SQL to run first.
     *
     * The photographer's thousands of rows carry no name and are excluded by
     * the server, so this stays roughly "one short string per guest photo"
     * however big the gallery gets.
     *
     * @param {string} [folder] same folder filter the gallery itself uses, so
     *        /test/ uploaders never show up in the real gallery's list.
     * @returns {Promise<Array<{name: string, count: number}>>} empty on error —
     *          a missing dropdown is better than a broken gallery.
     */
    async function fetchGuestNames(folder) {
        const tally = new Map();
        const step = 1000;
        let offset = 0;

        try {
            // Paged rather than one huge request: a wedding this size will
            // never need the second lap, but a truncated list would silently
            // lose whoever sorts last.
            for (let page = 0; page < 10; page++) {
                let url = CONFIG.SUPABASE_URL + "/rest/v1/photos" +
                    "?select=guest_name&deleted_at=is.null&guest_name=not.is.null" +
                    "&limit=" + step + "&offset=" + offset;
                if (folder) url += "&storage_path=like." + encodeURIComponent(folder + "/*");

                const res = await fetch(url, { headers: authHeaders() });
                if (!res.ok) return [];

                const rows = await res.json();
                rows.forEach(function (row) {
                    const name = String(row.guest_name || "").trim();
                    if (!name) return;
                    tally.set(name, (tally.get(name) || 0) + 1);
                });

                if (rows.length < step) break;
                offset += step;
            }
        } catch (err) {
            return [];
        }

        // Most photos first: the people who sent twenty are the ones anyone
        // is likely to go looking for. Ties fall back to Danish alphabetical.
        return Array.from(tally, function (entry) {
            return { name: entry[0], count: entry[1] };
        }).sort(function (a, b) {
            return b.count - a.count || a.name.localeCompare(b.name, "da");
        });
    }

    // A guest hiding their own photo. The token never leaves this browser
    // except in this one call, and the server decides whether it matches.
    async function hideOwnPhoto(photo) {
        const token = tokenFor(photo.id);
        if (!token) throw new Error("no token");

        let res;
        try {
            res = await fetch(CONFIG.SUPABASE_URL + "/rest/v1/rpc/delete_own_photo", {
                method: "POST",
                headers: Object.assign(anonHeaders(), { "Content-Type": "application/json" }),
                body: JSON.stringify({ p_id: photo.id, p_token: token })
            });
        } catch (err) {
            throw netError();
        }
        if (!res.ok) throw httpError(res.status);
        if ((await res.json()) !== true) throw new Error("token mismatch");
        forgetMine(photo.id);
    }

    // An admin deleting for real. Files first, then the row; a 400/404 on a
    // file is tolerated so a half-finished delete can simply be retried.
    async function purgePhoto(photo) {
        if (!(await ensureSession())) throw new Error("not signed in");

        // A video and its poster live in the video bucket; everything else in
        // the photo bucket. Delete against the wrong one answers 404 and the
        // files would quietly survive the row.
        const bucket = bucketFor(photo.kind);

        // original_path belongs in here too: it is the photographer's untouched
        // file and by far the biggest of the three, so leaving it behind means
        // "slet permanent" quietly keeps the largest part of the photo.
        for (const path of [photo.storage_path, photo.thumb_path, photo.original_path]) {
            if (!path) continue;
            try {
                await fetch(CONFIG.SUPABASE_URL + "/storage/v1/object/" + bucket + "/" + path, {
                    method: "DELETE",
                    headers: authHeaders()
                });
            } catch (err) {
                /* network hiccup on a file — the row delete below still decides */
            }
        }

        let res;
        try {
            res = await fetch(CONFIG.SUPABASE_URL + "/rest/v1/photos?id=eq." + encodeURIComponent(photo.id), {
                method: "DELETE",
                headers: authHeaders()
            });
        } catch (err) {
            throw netError();
        }
        if (!res.ok) throw httpError(res.status);
        forgetMine(photo.id);
    }

    function rememberOrphan(path) {
        // The file is safely in storage but its metadata row never landed, so
        // it would be invisible in the gallery. Keep a note so it can be
        // reconciled from the dashboard afterwards.
        const list = readStore(ORPHAN_KEY, []);
        list.push(path);
        writeStore(ORPHAN_KEY, list);
    }

    // --- OPENING TIME ------------------------------------------------------

    function opensAt() {
        return new Date(CONFIG.OPENS_AT).getTime();
    }

    /**
     * Escape hatch so the printed QR card can be tested on a real phone before
     * the day. Visit any page once with ?forhaandsvisning=1 and this browser
     * skips the gate from then on; ?forhaandsvisning=0 turns it off again.
     * Sticky on purpose — a scanned QR carries no query string, so a one-shot
     * parameter could never unlock the flow we actually want to rehearse.
     */
    function previewing() {
        let stored = false;
        try {
            stored = localStorage.getItem(PREVIEW_KEY) === "1";
        } catch (e) { /* private mode */ }

        const q = new URLSearchParams(window.location.search).get("forhaandsvisning");
        if (q === null) return stored;

        const on = q !== "0" && q !== "false";
        try {
            if (on) localStorage.setItem(PREVIEW_KEY, "1");
            else localStorage.removeItem(PREVIEW_KEY);
        } catch (e) { /* private mode */ }
        return on;
    }

    function isOpen() {
        return previewing() || Date.now() >= opensAt();
    }

    /**
     * Shown in place of the uploader until the wedding moment arrives. No
     * clock here on purpose — the countdown lives on the front page, and two
     * of them on one site is one too many.
     * @param {Function} onOpen called once the moment arrives, so a phone left
     *        open through 13:00 unlocks without a reload.
     */
    function buildLocked(mount, onOpen) {
        const wrap = el("div", "wed-locked");

        const ornament = el("div", "ornament ornament-sm");
        ornament.appendChild(el("span", "ornament-line"));
        ornament.appendChild(el("span", "ornament-diamond"));
        ornament.appendChild(el("span", "ornament-line"));

        wrap.appendChild(el("h3", null, "Vi åbner for billeder på selve dagen"));
        wrap.appendChild(ornament);
        wrap.appendChild(el("p", null,
            "Her kan I dele jeres billeder fra dagen. Vi vil også lægge fotografens billeder op her, når de er klar."));

        mount.textContent = "";
        mount.appendChild(wrap);

        // Nothing ticks any more, so wait out the remaining time in one go
        // rather than waking up every second. setTimeout tops out at ~24.8
        // days; beyond that just skip it — nobody leaves a tab open that long,
        // and a reload re-arms it.
        const distance = opensAt() - Date.now();
        if (distance > 0 && distance <= 2147483647) setTimeout(onOpen, distance);
    }

    /**
     * The "Billeder fra dagen" heading lives in the page markup, not in here,
     * so hide the whole enclosing <section> — otherwise the gate leaves a bare
     * heading over nothing. Inline style, because .content sets an explicit
     * display that would beat the [hidden] rule.
     */
    function setSectionShown(mount, shown) {
        if (!mount) return;
        const section = mount.closest("section") || mount;
        section.style.display = shown ? "" : "none";
    }

    /**
     * Videos can't go through the uploader — see CONFIG.VIDEO_EMAIL. Sits with
     * the uploader rather than in the page markup so it only ever shows once
     * the page has opened; before that the whole uploader is replaced by the
     * "we open on the day" card, and pointing guests at WeTransfer early would
     * just invite video before there is any wedding to film.
     */
    function buildVideoNote() {
        const wrap = el("div", "wed-video");

        const lead = el("p", "wed-video-lead");
        lead.appendChild(document.createTextNode("Har I videoer? Send dem til os med "));
        const link = el("a", null, "WeTransfer");
        link.href = "https://wetransfer.com";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        lead.appendChild(link);
        lead.appendChild(document.createTextNode(" - video kan ikke uploades her på siden."));
        wrap.appendChild(lead);

        const guide = el("details", "wed-video-guide");
        guide.appendChild(el("summary", null, "Sådan gør du"));

        const steps = el("ol");
        [
            "Gå ind på wetransfer.com. Du skal hverken oprette dig eller hente en app.",
            "Tryk på plusset, og vælg de videoer, du vil sende.",
            "Skriv vores mail i feltet “send til”: " + CONFIG.VIDEO_EMAIL,
            "Skriv din egen mail, så vi kan se, hvem de er fra.",
            "Tryk “Transfer”. Så får vi en mail, når de er kommet frem."
        ].forEach(function (text) {
            steps.appendChild(el("li", null, text));
        });
        guide.appendChild(steps);

        guide.appendChild(el("p", "wed-fineprint",
            "Gratis kan man sende op til 3 GB — det er rigtig meget video. " +
            "Linket holder kun et par dage, så send dem hellere med det samme, " +
            "end at gemme det til næste weekend."));

        wrap.appendChild(guide);
        return wrap;
    }

    // --- UPLOADER ----------------------------------------------------------

    function buildUploader(mount, state) {
        const wrap = el("div", "wed-upload");

        // The name is not a question any more: it comes from the invitation
        // the guest arrived on. Nothing to type, nothing to get wrong, and the
        // people filter in the gallery stays clean — one spelling per guest
        // instead of "Helle", "helle" and "Helle og H" as three strangers.
        const credit = el("p", "wed-credit");
        if (state.name) {
            credit.appendChild(el("span", "wed-credit-label", "Billederne deles i jeres navn"));
            credit.appendChild(el("span", "wed-credit-name", state.name));
        } else {
            // /test/ has no invitation and so no name to show.
            credit.hidden = true;
        }

        const fileInput = el("input", "wed-file-input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.multiple = true;
        // Deliberately no capture="environment": that swaps the OS picker for a
        // bare camera and hides the photo library, which is where the photos
        // guests actually want to send already are.

        const cta = el("button", "upload-cta", "Vælg billeder");
        cta.type = "button";

        const hint = el("p", "wed-hint", "Man kan vælge flere billeder på én gang.");
        const banner = el("div", "wed-banner");
        banner.hidden = true;
        const summary = el("div", "wed-summary");
        summary.hidden = true;
        const list = el("ul", "wed-list");

        wrap.appendChild(credit);
        wrap.appendChild(cta);
        wrap.appendChild(fileInput);
        wrap.appendChild(hint);
        wrap.appendChild(banner);
        wrap.appendChild(summary);
        wrap.appendChild(list);
        wrap.appendChild(buildVideoNote());
        mount.appendChild(wrap);

        if (!isConfigured()) {
            cta.disabled = true;
            banner.hidden = false;
            banner.className = "wed-banner error";
            banner.textContent = "Billedupload er ikke sat op endnu.";
            return;
        }

        cta.addEventListener("click", function () { fileInput.click(); });

        const queue = createQueue({
            list: list,
            summary: summary,
            banner: banner,
            wrap: wrap,
            cta: cta,
            state: state
        });

        fileInput.addEventListener("change", function () {
            const files = Array.prototype.slice.call(fileInput.files || []);
            fileInput.value = ""; // let the same file be picked again after a failure
            if (files.length) queue.add(files);
        });

        window.addEventListener("online", function () {
            banner.hidden = true;
            queue.resumeFailed();
        });

        window.addEventListener("offline", function () {
            banner.hidden = false;
            banner.className = "wed-banner warn";
            banner.textContent = "Du er offline lige nu. Vi prøver igen automatisk, når forbindelsen er tilbage.";
        });

        window.addEventListener("beforeunload", function (e) {
            if (!queue.busy()) return;
            e.preventDefault();
            e.returnValue = "";
            return "";
        });
    }

    function createQueue(ui) {
        const items = [];
        let running = 0;

        function busy() {
            return items.some(function (item) {
                return item.status === "pending" || item.status === "working";
            });
        }

        function add(files) {
            files.forEach(function (file) {
                const item = createItem(file);
                items.push(item);
                ui.list.appendChild(item.node);
            });
            render();
            pump();
        }

        function createItem(file) {
            const node = el("li", "upload-card");
            const thumb = el("img", "upload-thumb");
            thumb.alt = "";
            const meta = el("div", "upload-meta");
            const status = el("div", "upload-status", "Venter…");
            const bar = el("div", "progress");
            const fill = el("span");
            bar.appendChild(fill);
            const retry = el("button", "upload-retry", "Prøv igen");
            retry.type = "button";
            retry.hidden = true;

            meta.appendChild(status);
            meta.appendChild(bar);
            meta.appendChild(retry);
            node.appendChild(thumb);
            node.appendChild(meta);

            const item = {
                file: file,           // kept so a retry never asks the guest to re-pick
                node: node,
                thumb: thumb,
                status: "pending",
                statusEl: status,
                fill: fill,
                retryBtn: retry,
                processed: null,      // cached so a retry skips re-encoding
                storedPath: null,     // set once the full-size file is safely up
                photoId: null,
                token: null
            };

            retry.addEventListener("click", function () {
                item.status = "pending";
                retry.hidden = true;
                setStatus(item, "Venter…");
                render();
                pump();
            });

            return item;
        }

        function setStatus(item, text, cls) {
            item.statusEl.textContent = text;
            item.node.className = "upload-card" + (cls ? " " + cls : "");
        }

        function setProgress(item, ratio) {
            item.fill.style.width = Math.round(ratio * 100) + "%";
        }

        function render() {
            // Counted in one pass rather than two filter() sweeps: render() runs
            // after every finished photo, so scanning the list each time is
            // quadratic over a large batch.
            const total = items.length;
            let failed = 0;
            let done = 0;
            for (let i = 0; i < total; i++) {
                if (items[i].status === "failed") failed++;
                else if (items[i].status === "done") done++;
            }

            if (!total) {
                ui.summary.hidden = true;
                return;
            }

            ui.summary.hidden = false;
            ui.summary.textContent = "";
            ui.summary.appendChild(el("span", null, done + " af " + total + " sendt"));

            if (failed && !busy()) {
                const retryAll = el("button", "wed-retry-all", "Prøv alle igen");
                retryAll.type = "button";
                retryAll.addEventListener("click", function () {
                    items.forEach(function (item) {
                        if (item.status !== "failed") return;
                        item.status = "pending";
                        item.retryBtn.hidden = true;
                        setStatus(item, "Venter…");
                    });
                    render();
                    pump();
                });
                ui.summary.appendChild(retryAll);
            }

            if (done === total && !failed) showSuccess(done);
        }

        function showSuccess(count) {
            ui.list.textContent = "";
            ui.summary.hidden = true;
            items.length = 0;

            const card = el("div", "wed-success");
            const ornament = el("div", "ornament ornament-sm");
            ornament.appendChild(el("span", "ornament-line"));
            ornament.appendChild(el("span", "ornament-diamond"));
            ornament.appendChild(el("span", "ornament-line"));

            card.appendChild(el("h3", null, "Tak!"));
            card.appendChild(ornament);
            card.appendChild(el("p", null,
                count === 1
                    ? "1 billede er sendt til Anne og Torben ❤️"
                    : count + " billeder er sendt til Anne og Torben ❤️"));
            card.appendChild(el("p", "wed-fineprint",
                "Fortryder du? Åbn dit billede i galleriet nedenfor og tryk Slet."));

            const more = el("button", "wed-more", "Send flere billeder");
            more.type = "button";
            more.addEventListener("click", function () {
                card.remove();
                ui.cta.hidden = false;
            });
            card.appendChild(more);

            ui.cta.hidden = true;
            ui.list.parentNode.insertBefore(card, ui.list);
        }

        function pump() {
            while (running < CONFIG.CONCURRENCY) {
                const next = items.find(function (item) { return item.status === "pending"; });
                if (!next) break;
                running++;
                run(next).then(function () {
                    running--;
                    render();
                    pump();
                });
            }
        }

        async function run(item) {
            item.status = "working";

            try {
                if (!item.processed) {
                    setStatus(item, "Behandler…");
                    item.processed = await serialise(function () { return processImage(item.file); });
                    item.thumb.src = URL.createObjectURL(item.processed.thumb);
                    item.thumb.onload = function () { URL.revokeObjectURL(item.thumb.src); };
                }

                const processed = item.processed;

                if (!item.storedPath) {
                    const fileId = uuid();
                    // createQueue() has no closure over buildUploader's state —
                    // it arrives as ui.state.
                    const folder = (ui.state && ui.state.folder) || CONFIG.DAY_FOLDER;
                    const fullPath = folder + "/" + fileId + ".jpg";
                    const thumbPath = folder + "/" + fileId + "_t.jpg";

                    setStatus(item, "Sender… 0 %");
                    await withRetry(function () {
                        return uploadBlob(fullPath, processed.full, function (ratio) {
                            setProgress(item, ratio);
                            setStatus(item, "Sender… " + Math.round(ratio * 100) + " %");
                        });
                    });

                    await withRetry(function () { return uploadBlob(thumbPath, processed.thumb); });

                    item.storedPath = { full: fullPath, thumb: thumbPath };
                }

                // Generated up front so we know the row id without reading it
                // back, and so a retry reuses the same identity.
                if (!item.photoId) {
                    item.photoId = uuid();
                    item.token = secret();
                }

                setProgress(item, 1);
                setStatus(item, "Gemmer…");

                // Straight from the invitation — the guest never gets to edit
                // it, so every photo from one household files under one name.
                const guestName = String(ui.state.name || "").trim();
                const row = {
                    id: item.photoId,
                    storage_path: item.storedPath.full,
                    thumb_path: item.storedPath.thumb,
                    guest_name: guestName || null,
                    width: processed.width,
                    height: processed.height,
                    taken_at: new Date(item.file.lastModified || Date.now()).toISOString(),
                    delete_token: item.token
                };

                try {
                    await withRetry(function () { return insertRow(row); });
                } catch (err) {
                    rememberOrphan(item.storedPath.full);
                    throw err;
                }

                // Only now is it really "mine" — remembering earlier would leave
                // a token pointing at a row that never existed.
                rememberMine(item.photoId, item.token);

                item.status = "done";
                setStatus(item, "✓ Sendt", "is-done");

                // The two encoded Blobs are ~740 KB per photo and were only kept
                // so a retry could skip re-encoding. Once the row exists there is
                // nothing left to retry, and holding them turns a big batch into
                // hundreds of megabytes of dead weight.
                // (The preview's blob URL is already revoked by thumb.onload.)
                item.processed = null;

                if (window.WedPhotos._onUploaded) {
                    window.WedPhotos._onUploaded({
                        id: item.photoId,
                        storage_path: row.storage_path,
                        thumb_path: row.thumb_path,
                        guest_name: row.guest_name,
                        width: row.width,
                        height: row.height
                    });
                }
            } catch (err) {
                // Guests never see the console, but /test/ exists precisely so a
                // misbehaving phone can be diagnosed — keep the real error.
                console.error("[wed] upload failed:", err && err.message, err);
                item.status = "failed";
                item.retryBtn.hidden = false;
                setStatus(item, messageFor(err), "is-failed");
            }
        }

        function messageFor(err) {
            if (err.code === "DECODE") {
                return "Dette billedformat kunne ikke sendes (HEIC). Prøv at slå \"Høj effektivitet\" fra i kameraindstillingerne.";
            }
            if (err.status === 413) return "Billedet er for stort til at sende.";
            if (err.status === 400 || err.status === 415) {
                return "Vi kan desværre ikke sende denne fil. Prøv et almindeligt billede (JPG).";
            }
            if (err.status === 403) return "Upload er lukket lige nu.";
            return "Billedet blev ikke sendt. Tjek din forbindelse, og tryk \"Prøv igen\".";
        }

        function resumeFailed() {
            let woke = false;
            items.forEach(function (item) {
                if (item.status !== "failed") return;
                item.status = "pending";
                item.retryBtn.hidden = true;
                setStatus(item, "Venter…");
                woke = true;
            });
            if (woke) {
                render();
                pump();
            }
        }

        return { add: add, busy: busy, resumeFailed: resumeFailed };
    }

    // --- GALLERY -----------------------------------------------------------

    function buildGallery(mount, options) {
        const opts = options || {};
        const wrap = el("div", "wed-gallery");
        const filters = el("div", "gallery-filters");
        filters.hidden = true;          // shown only once we know it is useful

        // "Hvem har taget billedet" — a native <select> on purpose: on a phone
        // it opens the platform's own wheel, which handles forty names far
        // better than anything built out of divs.
        const peopleWrap = el("div", "gallery-people");
        peopleWrap.hidden = true;
        const peopleId = "wed-people-" + Math.random().toString(36).slice(2, 8);
        const peopleLabel = el("label", "gallery-people-label", "Billeder fra");
        peopleLabel.setAttribute("for", peopleId);
        const people = el("select", "gallery-people-select");
        people.id = peopleId;
        people.appendChild(el("option", null, "Alle, der har delt"));
        people.firstChild.value = "";
        peopleWrap.appendChild(peopleLabel);
        peopleWrap.appendChild(people);

        const count = el("p", "gallery-count");
        const grid = el("div", "photo-grid");
        const sentinel = el("div", "gallery-sentinel");
        wrap.appendChild(filters);
        wrap.appendChild(peopleWrap);
        wrap.appendChild(count);
        wrap.appendChild(grid);
        wrap.appendChild(sentinel);
        mount.appendChild(wrap);

        if (!isConfigured()) {
            count.textContent = "Galleriet åbner snart.";
            return null;
        }

        const photos = [];
        let lowestSeq = null;
        let exhausted = false;
        let loading = false;
        let total = null;
        let includeDeleted = false;
        let filter = null;              // null = alle

        // The photographer's set is thousands of images and lands on top of
        // everything, so without this the guests' own photos are pushed
        // hundreds of pages down and effectively disappear. The ten videos
        // would vanish the same way, only faster.
        function buildFilters() {
            // There is deliberately no "Alle" and no "Gæsterne" pill. Until the
            // photographer's set and the videos are imported those two say the
            // same thing as each other and as the unfiltered gallery, and the
            // people dropdown now covers "whose photos". Both tabs below only
            // appear once there is something behind them, so most of the time
            // this bar is empty and stays out of the way entirely.
            const choices = [
                { id: "video", value: { kind: "video" }, label: "Video" },
                { id: "photographer", value: { source: "photographer" }, label: "Fotografen" }
            ];
            const buttons = [];
            let active = null;

            function activate(id) {
                active = id;
                buttons.forEach(function (b) {
                    b.classList.toggle("is-active", b.dataset.filterId === id);
                });
            }

            choices.forEach(function (choice) {
                const button = el("button", "gallery-filter", choice.label);
                button.type = "button";
                button.dataset.filterId = choice.id;
                button.hidden = true;

                button.addEventListener("click", function () {
                    // Pressing the active tab again turns it off. With no
                    // "Alle" pill left this is the way back to the whole
                    // gallery, so a tab must not be a one-way door.
                    const turningOff = active === choice.id;
                    activate(turningOff ? null : choice.id);
                    filter = turningOff ? null : choice.value;
                    // A tab and a person are two answers to the same question,
                    // so picking a tab drops the person rather than quietly
                    // intersecting the two into an empty page.
                    people.value = "";
                    reload();
                });

                buttons.push(button);
                filters.appendChild(button);

                countMatching(choice.value).then(function (n) {
                    if (n === 0) return;
                    button.hidden = false;
                    // The bar reveals itself only when a pill inside it does,
                    // so an empty row never takes up space above the photos.
                    filters.hidden = false;
                });
            });

            people.addEventListener("change", function () {
                const name = people.value;
                // A person and a tab are mutually exclusive, so choosing one
                // clears the other.
                activate(null);
                filter = name ? { guestName: name } : null;
                reload();
            });

            // The list is only worth showing once there is a choice to make:
            // with a single uploader it just repeats the gallery itself.
            fetchGuestNames(opts.folder).then(function (names) {
                if (names.length < 2) return;

                names.forEach(function (entry) {
                    const option = el("option", null, entry.name + " (" + entry.count + ")");
                    option.value = entry.name;
                    people.appendChild(option);
                });

                peopleWrap.hidden = false;
            });
        }

        const lightbox = buildLightbox(photos, {
            onRemoved: removePhoto,
            adminMode: opts.admin === true
        });
        mount.appendChild(lightbox.node);

        function renderCount() {
            if (total == null) return;
            const noun = total === 1 ? "billede" : "billeder";
            if (filter && filter.guestName) {
                count.textContent = total + " " + noun + " fra " + filter.guestName;
            } else if (filter && filter.kind === "video") {
                count.textContent = total === 1 ? "1 video fra dagen" : total + " videoer fra dagen";
            } else {
                count.textContent = total + " " + noun + " fra dagen";
            }
        }

        function addTile(photo, atStart) {
            if (atStart) photos.unshift(photo);
            else photos.push(photo);

            const isVideo = photo.kind === "video";

            const button = el("button", "photo-tile");
            button.type = "button";
            if (photo.deleted_at) button.classList.add("is-deleted");
            if (isVideo) button.classList.add("is-video");

            // A video tile is its poster frame — the same 480 px JPEG the
            // photos use — so the grid stays one uniform thing and no MP4 is
            // touched until someone actually opens it.
            const img = el("img");
            img.src = publicUrl(photo.thumb_path, photo.kind);
            img.loading = "lazy";
            img.decoding = "async";
            img.alt = isVideo
                ? (photo.title || "Video fra brylluppet")
                : (photo.guest_name ? "Billede delt af " + photo.guest_name : "Billede fra brylluppet");
            if (photo.width && photo.height) {
                img.width = photo.width;
                img.height = photo.height;
            }
            img.addEventListener("load", function () { button.classList.add("is-loaded"); });
            button.appendChild(img);

            if (isVideo) {
                button.appendChild(el("span", "tile-play"));
                if (photo.duration_s) {
                    button.appendChild(el("span", "tile-duration", runtime(photo.duration_s)));
                }
                if (photo.title) button.appendChild(el("span", "tile-title", photo.title));
            }
            button.addEventListener("click", function () {
                lightbox.open(photos.indexOf(photo));
            });

            photo._tile = button;
            if (atStart) grid.insertBefore(button, grid.firstChild);
            else grid.appendChild(button);
        }

        function removePhoto(photo) {
            const i = photos.indexOf(photo);
            if (i !== -1) photos.splice(i, 1);
            if (photo._tile) photo._tile.remove();
            if (total != null && total > 0) {
                total--;
                renderCount();
            }
        }

        function reload() {
            photos.length = 0;
            grid.textContent = "";
            lowestSeq = null;
            exhausted = false;
            total = null;
            loadMore();
        }

        async function loadMore() {
            if (loading || exhausted) return;
            loading = true;
            sentinel.textContent = "Indlæser flere…";

            try {
                const page = await fetchPage(lowestSeq, total == null, includeDeleted,
                    opts.folder, filter);
                if (page.total != null) {
                    total = page.total;
                    renderCount();
                }

                page.rows.forEach(function (row) {
                    addTile(row, false);
                    if (lowestSeq == null || row.seq < lowestSeq) lowestSeq = row.seq;
                });

                if (page.rows.length < CONFIG.PAGE_SIZE) {
                    exhausted = true;
                    const kind = filter && filter.kind;
                    const from = filter && filter.source;
                    const who = filter && filter.guestName;
                    if (photos.length) {
                        sentinel.textContent = kind === "video"
                            ? "Det var alle videoer ❤️"
                            : (who ? "Det var alle billeder fra " + who + " ❤️"
                                   : "Det var alle billeder ❤️");
                    } else if (who) {
                        sentinel.textContent = who + " har ikke delt nogen billeder endnu.";
                    } else if (kind === "video") {
                        sentinel.textContent = "Videoerne er der ikke endnu.";
                    } else if (from === "photographer") {
                        sentinel.textContent = "Fotografens billeder er der ikke endnu.";
                    } else {
                        sentinel.textContent = "Der er ingen billeder endnu — vær den første!";
                    }
                } else {
                    sentinel.textContent = "";
                }
            } catch (err) {
                sentinel.textContent = "";
                const retry = el("button", "wed-retry-all", "Prøv igen");
                retry.type = "button";
                retry.addEventListener("click", function () {
                    sentinel.textContent = "";
                    loadMore();
                });
                sentinel.appendChild(el("span", null, "Billederne kunne ikke hentes. "));
                sentinel.appendChild(retry);
            } finally {
                loading = false;
            }
        }

        // Same IntersectionObserver idea as the scroll animations in script.js.
        const observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) loadMore();
            });
        }, { rootMargin: "600px 0px" });
        observer.observe(sentinel);

        buildFilters();
        loadMore();

        // Let a guest see their own photo land at the top straight away.
        window.WedPhotos._onUploaded = function (photo) {
            // A guest's new photo must not appear while the photographer's
            // photos — or the videos — are the ones being shown, nor while
            // someone else's name is selected.
            if (filter && (filter.source === "photographer" || filter.kind)) return;
            if (filter && filter.guestName && photo.guest_name !== filter.guestName) return;
            addTile(photo, true);
            if (total != null) {
                total++;
                renderCount();
            }
        };

        return {
            reload: reload,
            setIncludeDeleted: function (value) {
                includeDeleted = value;
                reload();
            },
            setAdmin: function (value) {
                lightbox.setAdmin(value);
                reload();
            }
        };
    }

    function buildLightbox(photos, options) {
        const opts = options || {};
        let adminMode = opts.adminMode === true;

        const dialog = el("dialog", "lightbox");
        const figure = el("figure", "lightbox-figure");
        const img = el("img", "lightbox-img");

        // preload="none" is deliberate: opening a video must not start pulling
        // an MP4 down before anyone has pressed play. Two hours of speeches
        // served to a hundred guests is the one thing on this site that can
        // run up a real bandwidth bill.
        const video = el("video", "lightbox-video");
        video.controls = true;
        video.playsInline = true;
        video.preload = "none";
        video.hidden = true;

        const caption = el("figcaption", "lightbox-caption");

        // Only on iPhone/iPad, and only for photos: long-pressing a <video>
        // offers no such thing, so the tip would be a lie there.
        const hint = el("p", "lightbox-hint",
            "Tip: hold fingeren på billedet for at gemme det i Billeder");
        hint.hidden = true;

        figure.appendChild(img);
        figure.appendChild(video);
        figure.appendChild(caption);
        figure.appendChild(hint);

        // Stop a video dead and drop its connection. Without this a video you
        // swiped past keeps streaming in the background — invisible, audible
        // only sometimes, and billed either way.
        function releaseVideo() {
            if (!video.getAttribute("src")) return;
            video.pause();
            video.removeAttribute("src");
            video.load();
        }

        const close = el("button", "lightbox-close", "×");
        close.type = "button";
        close.setAttribute("aria-label", "Luk");
        const prev = el("button", "lightbox-nav prev", "‹");
        prev.type = "button";
        prev.setAttribute("aria-label", "Forrige");
        const next = el("button", "lightbox-nav next", "›");
        next.type = "button";
        next.setAttribute("aria-label", "Næste");

        // Toolbar: download always, delete when it's yours or you're the admin.
        const bar = el("div", "lightbox-bar");

        // Stays a real <a href> whatever happens: that is the fallback when
        // the share sheet is unavailable, refused, or the file is too big, and
        // it is what makes the control work with no JavaScript at all.
        const download = el("a", "lightbox-action", "Download");
        download.setAttribute("download", "");
        const del = el("button", "lightbox-action danger", "Slet");
        del.type = "button";
        const confirmBtn = el("button", "lightbox-action danger confirm", "Ja, slet");
        confirmBtn.type = "button";
        confirmBtn.hidden = true;
        const cancelBtn = el("button", "lightbox-action", "Fortryd");
        cancelBtn.type = "button";
        cancelBtn.hidden = true;
        const note = el("span", "lightbox-note");

        bar.appendChild(download);
        bar.appendChild(del);
        bar.appendChild(confirmBtn);
        bar.appendChild(cancelBtn);
        bar.appendChild(note);

        dialog.appendChild(close);
        dialog.appendChild(prev);
        dialog.appendChild(figure);
        dialog.appendChild(next);
        dialog.appendChild(bar);

        let index = 0;

        function resetDeleteUI() {
            confirmBtn.hidden = true;
            cancelBtn.hidden = true;
            note.textContent = "";
            del.disabled = false;
        }

        function canDelete(photo) {
            return adminMode || !!tokenFor(photo.id);
        }

        function show(i) {
            if (i < 0 || i >= photos.length) return;
            index = i;
            const photo = photos[i];

            const isVideo = photo.kind === "video";

            // Always let go of the previous video, whether the next item is a
            // photo or another video.
            releaseVideo();

            img.hidden = isVideo;
            video.hidden = !isVideo;

            if (isVideo) {
                img.removeAttribute("src");

                // Size the player to the video's own shape BEFORE any of it is
                // downloaded. preload="none" means the browser has no metadata
                // to go on, so it would give the element its default 2:1-ish
                // box — and a 16:9 speech on an upright phone would sit in
                // ~400 px of black bars with the caption pushed off-screen.
                // The dimensions are in the row precisely for this.
                video.style.aspectRatio = (photo.width && photo.height)
                    ? photo.width + " / " + photo.height
                    : "16 / 9";

                video.poster = publicUrl(photo.thumb_path, photo.kind);
                video.src = publicUrl(photo.storage_path, photo.kind);
            } else {
                img.src = publicUrl(photo.storage_path, photo.kind);
            }

            // The photographer's images carry no guest_name — saying nothing at
            // all would read as a photo nobody will admit to.
            const byline = isVideo
                ? (photo.title || "Video fra brylluppet")
                : (photo.source === "photographer"
                    ? "Fotografens billede"
                    : (photo.guest_name ? "Delt af " + photo.guest_name : ""));

            img.alt = byline || "Billede fra brylluppet";

            let text = byline;
            if (isVideo && photo.duration_s) {
                text = (text ? text + " · " : "") + runtime(photo.duration_s);
            }
            if (photo.original_path) text = (text ? text + " · " : "") + "Download giver originalen";
            if (photo.deleted_at) text = (text ? text + " · " : "") + "Slettet af gæsten";
            caption.textContent = text;

            download.href = downloadUrl(photo);
            // On a phone this button saves to the photo library rather than
            // downloading to Filer, so it should not say "Download".
            download.textContent = canSaveToLibrary()
                ? (isVideo ? "Gem video" : "Gem billede")
                : "Download";
            hint.hidden = isVideo || !isIOS();
            del.hidden = !canDelete(photo);
            del.textContent = adminMode ? "Slet permanent" : "Slet";
            resetDeleteUI();

            prev.hidden = i === 0;
            next.hidden = i === photos.length - 1;

            // Warm the neighbours so swiping feels instant. Videos are skipped
            // on purpose: this would fetch an entire MP4 in order to fail at
            // decoding it as an image.
            [i - 1, i + 1].forEach(function (n) {
                if (n < 0 || n >= photos.length) return;
                const neighbour = photos[n];
                if (neighbour.kind === "video") return;
                const pre = new Image();
                pre.src = publicUrl(neighbour.storage_path, neighbour.kind);
            });
        }

        function open(i) {
            show(i);
            if (dialog.showModal) dialog.showModal();
            else dialog.setAttribute("open", "");
            document.body.classList.add("lightbox-open");
        }

        // Inline two-step confirm rather than window.confirm(), which on a
        // phone is a jarring system dialog over a photo.
        del.addEventListener("click", function () {
            confirmBtn.hidden = false;
            cancelBtn.hidden = false;
            del.disabled = true;
            note.textContent = adminMode
                ? "Billedet og filerne slettes for altid."
                : "Billedet fjernes fra galleriet.";
        });

        cancelBtn.addEventListener("click", resetDeleteUI);

        confirmBtn.addEventListener("click", async function () {
            const photo = photos[index];
            confirmBtn.disabled = true;
            note.textContent = "Sletter…";

            try {
                if (adminMode) await purgePhoto(photo);
                else await hideOwnPhoto(photo);

                if (opts.onRemoved) opts.onRemoved(photo);
                confirmBtn.disabled = false;

                if (!photos.length) {
                    dismiss();
                } else {
                    show(Math.min(index, photos.length - 1));
                }
            } catch (err) {
                confirmBtn.disabled = false;
                note.textContent = err.status === 401 || err.status === 403
                    ? "Du har ikke lov til at slette dette billede."
                    : "Kunne ikke slette. Prøv igen.";
            }
        });

        // Hand the file to the OS so it can be saved into the photo library.
        // Falls back to the plain download for anything that does not work
        // out: no share sheet, file too large to hold in memory, or a browser
        // that refuses the call. The <a href> is left intact for exactly that.
        download.addEventListener("click", async function (e) {
            if (!canSaveToLibrary()) return;         // desktop: let the link run

            const photo = photos[index];
            const href = download.href;
            e.preventDefault();

            const original = download.textContent;
            download.textContent = "Henter…";

            try {
                const res = await fetch(href);
                if (!res.ok) throw new Error("http " + res.status);

                // Check the size before pulling the body into memory.
                const size = Number(res.headers.get("content-length") || 0);
                if (size > MAX_SHARE_BYTES) throw new Error("too big");

                const blob = await res.blob();
                const name = decodeURIComponent((/download=([^&]*)/.exec(href) || [])[1] || "billede.jpg");
                const file = new File([blob], name, { type: blob.type || "application/octet-stream" });

                if (!navigator.canShare({ files: [file] })) throw new Error("cannot share this");
                await navigator.share({ files: [file] });
            } catch (err) {
                // Cancelling the share sheet is not a failure — the guest
                // changed their mind, and re-downloading would be rude.
                if (err && err.name === "AbortError") return;
                // Anything else: fall back to the ordinary download.
                window.location.href = href;
            } finally {
                download.textContent = original;
            }
        });

        // Every route out of the lightbox releases the video itself rather
        // than trusting the close event alone. releaseVideo() is idempotent,
        // and a video that keeps streaming after you have left is the one
        // failure here that costs real money.
        function dismiss() {
            releaseVideo();
            dialog.close();
        }

        close.addEventListener("click", dismiss);
        prev.addEventListener("click", function () { show(index - 1); });
        next.addEventListener("click", function () { show(index + 1); });

        dialog.addEventListener("close", function () {
            document.body.classList.remove("lightbox-open");
            img.removeAttribute("src");
            releaseVideo();
            resetDeleteUI();
        });

        // Click the backdrop (i.e. the dialog itself, not the picture) to close.
        dialog.addEventListener("click", function (e) {
            if (e.target === dialog) dismiss();
        });

        // Esc goes through cancel, which fires before close.
        dialog.addEventListener("cancel", releaseVideo);

        dialog.addEventListener("keydown", function (e) {
            // With a video focused the arrows belong to the player — seeking
            // and jumping to the next speech at the same time is nobody's idea
            // of a shortcut.
            if (e.target === video) return;
            if (e.key === "ArrowLeft") show(index - 1);
            else if (e.key === "ArrowRight") show(index + 1);
        });

        let touchX = null;
        dialog.addEventListener("touchstart", function (e) {
            // Dragging the scrubber is a horizontal swipe. Left alone it would
            // also count as "next photo", so a touch that starts on the player
            // never navigates.
            touchX = e.target === video ? null : e.changedTouches[0].clientX;
        }, { passive: true });
        dialog.addEventListener("touchend", function (e) {
            if (touchX == null) return;
            const dx = e.changedTouches[0].clientX - touchX;
            touchX = null;
            if (Math.abs(dx) < 50) return;
            show(dx < 0 ? index + 1 : index - 1);
        }, { passive: true });

        return {
            node: dialog,
            open: open,
            setAdmin: function (value) { adminMode = value; }
        };
    }

    // --- ADMIN PANEL -------------------------------------------------------

    function buildAdmin(mount, gallery) {
        const wrap = el("div", "wed-admin");
        mount.appendChild(wrap);

        function renderSignedOut(message) {
            wrap.textContent = "";
            const form = el("form", "wed-admin-form");

            const email = el("input", "wed-name-input");
            email.type = "email";
            email.placeholder = "E-mail";
            email.autocomplete = "username";
            email.required = true;

            const password = el("input", "wed-name-input");
            password.type = "password";
            password.placeholder = "Adgangskode";
            password.autocomplete = "current-password";
            password.required = true;

            const submit = el("button", "upload-cta", "Log ind");
            submit.type = "submit";

            const error = el("p", "wed-admin-error");
            if (message) error.textContent = message;

            form.appendChild(email);
            form.appendChild(password);
            form.appendChild(submit);
            form.appendChild(error);
            wrap.appendChild(form);

            form.addEventListener("submit", async function (e) {
                e.preventDefault();
                submit.disabled = true;
                submit.textContent = "Logger ind…";
                error.textContent = "";
                try {
                    await signIn(email.value.trim(), password.value);
                    renderSignedIn();
                    if (gallery) gallery.setAdmin(true);
                } catch (err) {
                    submit.disabled = false;
                    submit.textContent = "Log ind";
                    error.textContent = err.status === 400
                        ? "Forkert e-mail eller adgangskode."
                        : "Kunne ikke logge ind. Prøv igen.";
                }
            });
        }

        function renderSignedIn() {
            wrap.textContent = "";

            const status = el("p", "wed-admin-status",
                "Logget ind som " + ((session && session.email) || "admin") +
                ". Åbn et billede for at slette det.");

            const row = el("div", "wed-admin-row");

            const toggleLabel = el("label", "wed-admin-toggle");
            const toggle = el("input");
            toggle.type = "checkbox";
            toggleLabel.appendChild(toggle);
            toggleLabel.appendChild(el("span", null, "Vis også billeder, gæster har slettet"));

            const out = el("button", "wed-retry-all", "Log ud");
            out.type = "button";

            row.appendChild(toggleLabel);
            row.appendChild(out);
            wrap.appendChild(status);
            wrap.appendChild(row);

            toggle.addEventListener("change", function () {
                if (gallery) gallery.setIncludeDeleted(toggle.checked);
            });

            out.addEventListener("click", async function () {
                await signOut();
                if (gallery) gallery.setAdmin(false);
                renderSignedOut();
            });
        }

        if (!isConfigured()) {
            wrap.appendChild(el("p", "wed-admin-error", "Supabase er ikke sat op endnu."));
            return;
        }

        if (isAdmin()) {
            renderSignedIn();
            // Refresh in the background; drop straight to the form if the
            // stored session has gone stale.
            ensureSession().then(function (ok) {
                if (!ok) {
                    if (gallery) gallery.setAdmin(false);
                    renderSignedOut("Din session er udløbet. Log ind igen.");
                }
            });
        } else {
            renderSignedOut();
        }
    }

    // --- PUBLIC API --------------------------------------------------------

    window.WedPhotos = {
        /**
         * @param {Object} options
         * @param {string} [options.mode]  "guest" | "test" | "admin"
         *        guest — the real gallery, locked until the wedding starts.
         *        test  — same UI, never locked, reads and writes a separate
         *                folder so nothing leaks into the real gallery.
         *        admin — every photo from every folder, deleted ones included.
         * @param {string} [options.name]  known guest name, used to prefill the credit field
         */
        init: function (options) {
            const opts = options || {};
            const state = { mode: opts.mode || "guest", name: opts.name || "" };
            const admin = state.mode === "admin";
            const test = state.mode === "test";

            // Admin deliberately gets no folder filter: it is the one place
            // that has to be able to see and purge test uploads too.
            const folder = admin ? null : (test ? CONFIG.TEST_FOLDER : CONFIG.DAY_FOLDER);
            state.folder = folder;

            const uploadMount = document.getElementById("wed-uploader");
            const galleryMount = document.getElementById("wed-gallery");
            const adminMount = document.getElementById("wed-admin");

            // Before the wedding there is nothing to send and nothing to look
            // at. Admin and test are exempt — both exist to be used early.
            if (!admin && !test && !isOpen()) {
                setSectionShown(galleryMount, false);
                if (uploadMount) {
                    buildLocked(uploadMount, function () {
                        window.WedPhotos.init(opts);
                    });
                }
                return;
            }
            setSectionShown(galleryMount, true);

            if (uploadMount && !admin) {
                uploadMount.textContent = "";   // may hold the countdown card
                buildUploader(uploadMount, state);
            }

            const gallery = galleryMount
                ? buildGallery(galleryMount, { admin: admin && isAdmin(), folder: folder })
                : null;

            if (adminMount) buildAdmin(adminMount, gallery);
        }
    };
})();
