/* =========================================================================
   GÆSTEBILLEDER — upload + galleri
   -------------------------------------------------------------------------
   Shared by /fest/ (open, reached via the printed QR code) and /Galleri/
   (behind the normal ?uid= gate). Both pages just drop in the two mount
   points and call WedPhotos.init(); everything below builds the UI itself so
   the two pages can never drift apart.

   Talks straight to Supabase from the browser — there is no server. Note
   that unlike the Google Apps Script calls in RSVP/index.html we do NOT use
   mode:"no-cors" here: Supabase sends real CORS headers, and real status
   codes are what make the retry logic and the honest error messages work.
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

        MAX_EDGE: 2560,      // longest edge of the stored photo (prints fine at 8x10")
        JPEG_Q: 0.82,
        THUMB_EDGE: 480,
        THUMB_Q: 0.7,

        PAGE_SIZE: 48,
        CONCURRENCY: 2,      // parallel uploads; decoding is always serial
        TIMEOUT_MS: 60000,
        RETRY_DELAYS: [1000, 3000, 8000]
    };

    const NAME_KEY = "wed_guest_name";
    const ORPHAN_KEY = "wed_orphans";

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

    function isConfigured() {
        return CONFIG.SUPABASE_URL.indexOf("DIT-PROJEKT") === -1 &&
            CONFIG.SUPABASE_ANON_KEY.indexOf("DIN_ANON_KEY") === -1;
    }

    function baseHeaders() {
        return {
            apikey: CONFIG.SUPABASE_ANON_KEY,
            Authorization: "Bearer " + CONFIG.SUPABASE_ANON_KEY
        };
    }

    function publicUrl(path) {
        return CONFIG.SUPABASE_URL + "/storage/v1/object/public/" + CONFIG.BUCKET + "/" + path;
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
                headers: Object.assign(baseHeaders(), {
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

    async function fetchPage(beforeSeq, wantCount) {
        let url = CONFIG.SUPABASE_URL + "/rest/v1/photos" +
            "?select=storage_path,thumb_path,guest_name,width,height,seq" +
            "&order=seq.desc&limit=" + CONFIG.PAGE_SIZE;
        if (beforeSeq != null) url += "&seq=lt." + beforeSeq;

        const headers = baseHeaders();
        if (wantCount) headers.Prefer = "count=exact";

        let res;
        try {
            res = await fetch(url, { headers: headers });
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

    function rememberOrphan(path) {
        // The file is safely in storage but its metadata row never landed, so
        // it would be invisible in the gallery. Keep a note so it can be
        // reconciled from the dashboard afterwards.
        try {
            const list = JSON.parse(localStorage.getItem(ORPHAN_KEY) || "[]");
            list.push(path);
            localStorage.setItem(ORPHAN_KEY, JSON.stringify(list));
        } catch (err) {
            /* localStorage full or blocked — nothing useful to do */
        }
    }

    // --- UPLOADER ----------------------------------------------------------

    function buildUploader(mount, state) {
        const wrap = el("div", "wed-upload");

        const nameRow = el("div", "wed-name-row");
        const nameLabel = el("label", null, "Dit navn (så vi ved, hvem vi skal takke)");
        nameLabel.setAttribute("for", "wed-name");
        const nameInput = el("input", "wed-name-input");
        nameInput.id = "wed-name";
        nameInput.type = "text";
        nameInput.maxLength = 60;
        nameInput.autocomplete = "name";
        nameInput.placeholder = "Valgfrit";
        nameRow.appendChild(nameLabel);
        nameRow.appendChild(nameInput);

        const fileInput = el("input", "wed-file-input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.multiple = true;
        // Deliberately no capture="environment": that swaps the OS picker for a
        // bare camera and hides the photo library, which is where the photos
        // guests actually want to send already are.

        const cta = el("button", "upload-cta", "Vælg billeder");
        cta.type = "button";

        const hint = el("p", "wed-hint", "Du kan vælge flere billeder på én gang.");
        const banner = el("div", "wed-banner");
        banner.hidden = true;
        const summary = el("div", "wed-summary");
        summary.hidden = true;
        const list = el("ul", "wed-list");

        const help = el("details", "wed-help");
        help.appendChild(el("summary", null, "Problemer med at sende?"));
        help.appendChild(el("p", null,
            "Prøv at slå wifi fra og bruge mobildata i stedet — det hjælper som regel til fester, " +
            "hvor mange er på det samme netværk. Bliv på siden, indtil billederne er sendt."));

        wrap.appendChild(nameRow);
        wrap.appendChild(cta);
        wrap.appendChild(fileInput);
        wrap.appendChild(hint);
        wrap.appendChild(banner);
        wrap.appendChild(summary);
        wrap.appendChild(list);
        wrap.appendChild(help);
        mount.appendChild(wrap);

        if (!isConfigured()) {
            cta.disabled = true;
            banner.hidden = false;
            banner.className = "wed-banner error";
            banner.textContent = "Billedupload er ikke sat op endnu.";
            return;
        }

        // Prefer the name we already know from the invitation; otherwise reuse
        // whatever the guest typed last time on this phone.
        let storedName = "";
        try { storedName = localStorage.getItem(NAME_KEY) || ""; } catch (err) { /* private mode */ }
        nameInput.value = state.name || storedName;

        nameInput.addEventListener("change", function () {
            try { localStorage.setItem(NAME_KEY, nameInput.value.trim()); } catch (err) { /* ignore */ }
        });

        cta.addEventListener("click", function () { fileInput.click(); });

        const queue = createQueue({
            list: list,
            summary: summary,
            banner: banner,
            nameInput: nameInput,
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
        let sentCount = 0;

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
                storedPath: null      // set once the full-size file is safely up
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
            const total = items.length;
            const failed = items.filter(function (i) { return i.status === "failed"; }).length;
            const done = items.filter(function (i) { return i.status === "done"; }).length;

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
                const id = uuid();

                if (!item.storedPath) {
                    const fullPath = CONFIG.DAY_FOLDER + "/" + id + ".jpg";
                    const thumbPath = CONFIG.DAY_FOLDER + "/" + id + "_t.jpg";

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

                setProgress(item, 1);
                setStatus(item, "Gemmer…");

                const guestName = ui.nameInput.value.trim();
                try {
                    await withRetry(function () {
                        return insertRow({
                            storage_path: item.storedPath.full,
                            thumb_path: item.storedPath.thumb,
                            guest_name: guestName || null,
                            width: processed.width,
                            height: processed.height,
                            taken_at: new Date(item.file.lastModified || Date.now()).toISOString()
                        });
                    });
                } catch (err) {
                    rememberOrphan(item.storedPath.full);
                    throw err;
                }

                item.status = "done";
                setStatus(item, "✓ Sendt", "is-done");
                sentCount++;

                if (window.WedPhotos && window.WedPhotos._onUploaded) {
                    window.WedPhotos._onUploaded({
                        storage_path: item.storedPath.full,
                        thumb_path: item.storedPath.thumb,
                        guest_name: guestName || null,
                        width: processed.width,
                        height: processed.height
                    });
                }
            } catch (err) {
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

    function buildGallery(mount) {
        const wrap = el("div", "wed-gallery");
        const count = el("p", "gallery-count");
        const grid = el("div", "photo-grid");
        const sentinel = el("div", "gallery-sentinel");
        wrap.appendChild(count);
        wrap.appendChild(grid);
        wrap.appendChild(sentinel);
        mount.appendChild(wrap);

        if (!isConfigured()) {
            count.textContent = "Galleriet åbner snart.";
            return;
        }

        const photos = [];
        let lowestSeq = null;
        let exhausted = false;
        let loading = false;
        let total = null;

        const lightbox = buildLightbox(photos);
        mount.appendChild(lightbox.node);

        function renderCount() {
            if (total == null) return;
            count.textContent = total === 1 ? "1 billede fra dagen" : total + " billeder fra dagen";
        }

        function addTile(photo, atStart) {
            const index = atStart ? 0 : photos.length;
            if (atStart) photos.unshift(photo);
            else photos.push(photo);

            const button = el("button", "photo-tile");
            button.type = "button";
            const img = el("img");
            img.src = publicUrl(photo.thumb_path);
            img.loading = "lazy";
            img.decoding = "async";
            img.alt = photo.guest_name ? "Billede delt af " + photo.guest_name : "Billede fra brylluppet";
            if (photo.width && photo.height) {
                img.width = photo.width;
                img.height = photo.height;
            }
            img.addEventListener("load", function () { button.classList.add("is-loaded"); });
            button.appendChild(img);
            button.addEventListener("click", function () {
                lightbox.open(photos.indexOf(photo));
            });

            if (atStart) grid.insertBefore(button, grid.firstChild);
            else grid.appendChild(button);
            return index;
        }

        async function loadMore() {
            if (loading || exhausted) return;
            loading = true;
            sentinel.textContent = "Indlæser flere…";

            try {
                const page = await fetchPage(lowestSeq, total == null);
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
                    sentinel.textContent = photos.length
                        ? "Det var alle billeder ❤️"
                        : "Der er ingen billeder endnu — vær den første!";
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

        loadMore();

        // Let a guest see their own photo land at the top straight away.
        window.WedPhotos._onUploaded = function (photo) {
            addTile(photo, true);
            if (total != null) {
                total++;
                renderCount();
            }
        };
    }

    function buildLightbox(photos) {
        const dialog = el("dialog", "lightbox");
        const figure = el("figure", "lightbox-figure");
        const img = el("img", "lightbox-img");
        const caption = el("figcaption", "lightbox-caption");
        figure.appendChild(img);
        figure.appendChild(caption);

        const close = el("button", "lightbox-close", "×");
        close.type = "button";
        close.setAttribute("aria-label", "Luk");
        const prev = el("button", "lightbox-nav prev", "‹");
        prev.type = "button";
        prev.setAttribute("aria-label", "Forrige");
        const next = el("button", "lightbox-nav next", "›");
        next.type = "button";
        next.setAttribute("aria-label", "Næste");

        dialog.appendChild(close);
        dialog.appendChild(prev);
        dialog.appendChild(figure);
        dialog.appendChild(next);

        let index = 0;

        function show(i) {
            if (i < 0 || i >= photos.length) return;
            index = i;
            const photo = photos[i];
            img.src = publicUrl(photo.storage_path);
            img.alt = photo.guest_name ? "Billede delt af " + photo.guest_name : "Billede fra brylluppet";
            caption.textContent = photo.guest_name ? "Delt af " + photo.guest_name : "";
            prev.hidden = i === 0;
            next.hidden = i === photos.length - 1;

            // Warm the neighbours so swiping feels instant.
            [i - 1, i + 1].forEach(function (n) {
                if (n < 0 || n >= photos.length) return;
                const pre = new Image();
                pre.src = publicUrl(photos[n].storage_path);
            });
        }

        function open(i) {
            show(i);
            if (dialog.showModal) dialog.showModal();
            else dialog.setAttribute("open", "");
            document.body.classList.add("lightbox-open");
        }

        close.addEventListener("click", function () { dialog.close(); });
        prev.addEventListener("click", function () { show(index - 1); });
        next.addEventListener("click", function () { show(index + 1); });

        dialog.addEventListener("close", function () {
            document.body.classList.remove("lightbox-open");
            img.removeAttribute("src");
        });

        // Click the backdrop (i.e. the dialog itself, not the picture) to close.
        dialog.addEventListener("click", function (e) {
            if (e.target === dialog) dialog.close();
        });

        dialog.addEventListener("keydown", function (e) {
            if (e.key === "ArrowLeft") show(index - 1);
            else if (e.key === "ArrowRight") show(index + 1);
        });

        let touchX = null;
        dialog.addEventListener("touchstart", function (e) {
            touchX = e.changedTouches[0].clientX;
        }, { passive: true });
        dialog.addEventListener("touchend", function (e) {
            if (touchX == null) return;
            const dx = e.changedTouches[0].clientX - touchX;
            touchX = null;
            if (Math.abs(dx) < 50) return;
            show(dx < 0 ? index + 1 : index - 1);
        }, { passive: true });

        return { node: dialog, open: open };
    }

    // --- PUBLIC API --------------------------------------------------------

    window.WedPhotos = {
        /**
         * @param {Object} options
         * @param {string} [options.mode]  "party" (open page) or "guest" (uid-gated)
         * @param {string} [options.name]  known guest name, used to prefill the credit field
         */
        init: function (options) {
            const opts = options || {};
            const state = { mode: opts.mode || "party", name: opts.name || "" };

            const uploadMount = document.getElementById("wed-uploader");
            const galleryMount = document.getElementById("wed-gallery");

            if (uploadMount) buildUploader(uploadMount, state);
            if (galleryMount) buildGallery(galleryMount);
        }
    };
})();
