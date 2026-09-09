// Seeds a CodeHS sandbox with throwaway folders and programs for testing the
// bulk delete extension against a realistic list.
//
// This is NOT part of the extension. Paste it into the DevTools console on
// https://codehs.com/sandbox while logged in, then call one of:
//
//   await seedTestData()                       // 5 folders, 40 programs (default)
//   await seedTestData({folders: 2, programs: 10})
//   await seedTestData({loose: 0})             // every program inside a folder
//   await deleteEverything()                   // clear the sandbox again
//
// Programs are spread across the folders with the rest left at the top level,
// which is the shape that actually exercises the extension: folder rows and
// program rows interleaved in one grid, and more rows than fit on screen so the
// virtualisation and the select-all scroll walk both come into play.
//
// Every endpoint and field below was captured from the CodeHS UI itself rather
// than guessed — the names are not what you would predict (a folder is created
// by `add_folder` taking `folderName`, and `progtype` is a numeric code).

(() => {
    const ENDPOINTS = {
        createProgram: "https://codehs.com/editor/ajax/create_sandbox_program",
        addFolder: "https://codehs.com/library/ajax/add_folder",
        moveToFolder: "https://codehs.com/library/ajax/move_sandbox_to_folder",
        deleteItem: "https://codehs.com/library/ajax/delete_sandbox",
    };

    // progtype is a numeric id; 23 is "Java (main)".
    const JAVA_MAIN = "23";

    // AG Grid's row height, used to step the scroll walk by just under a viewport.
    const ROW_HEIGHT_PX = 56;

    function csrfToken() {
        const token = document.cookie
            .split("; ")
            .find((row) => row.startsWith("csrftoken="));
        return token ? token.split("=")[1] : "";
    }

    async function post(url, fields) {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-CSRFToken": csrfToken(),
            },
            body: new URLSearchParams(fields).toString(),
        });
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (e) {
            /* create_sandbox_program answers with an HTML fragment */
        }
        return { ok: res.ok, status: res.status, json, text };
    }

    // Runs tasks a few at a time. Fully serial is slow at 40 programs; unbounded
    // parallelism makes CodeHS start refusing requests.
    async function pooled(items, worker, size = 4) {
        const results = [];
        let cursor = 0;
        await Promise.all(
            Array.from({ length: Math.min(size, items.length) }, async () => {
                while (cursor < items.length) {
                    const index = cursor++;
                    results[index] = await worker(items[index], index);
                }
            })
        );
        return results;
    }

    async function createFolder(name) {
        const res = await post(ENDPOINTS.addFolder, {
            folderName: name,
            skip_html: "1",
            method: "add_folder",
        });
        const id = res.json && res.json.ID;
        if (!id) console.warn(`folder "${name}" failed:`, res.status, res.text.slice(0, 120));
        return id || null;
    }

    async function createProgram(name) {
        const res = await post(ENDPOINTS.createProgram, {
            name,
            progtype: JAVA_MAIN,
            start_with_blocks: "0",
            method: "create_sandbox_program",
        });
        // Answers {status, html, url, ID, gridRow}. Read ID rather than digging
        // through `html` — that field is JSON-escaped, so matching markup in it
        // needs to account for \" and quietly finds nothing if you forget.
        const id = res.json && res.json.ID;
        if (!id) console.warn(`program "${name}" failed:`, res.status, res.text.slice(0, 120));
        return id || null;
    }

    function moveToFolder(programId, folderId) {
        return post(ENDPOINTS.moveToFolder, {
            program: programId,
            dest_folder: folderId,
            method: "move_sandbox_to_folder",
        });
    }

    window.seedTestData = async function seedTestData(options = {}) {
        const folderCount = options.folders ?? 5;
        const programCount = options.programs ?? 40;
        // How many programs stay at the top level rather than going in a folder.
        const loose = options.loose ?? Math.round(programCount * 0.3);
        const prefix = options.prefix ?? "Test";

        console.log(
            `Seeding ${folderCount} folders and ${programCount} programs ` +
                `(${loose} left at the top level)…`
        );

        const folders = (
            await pooled(
                Array.from({ length: folderCount }, (_, i) => i),
                (i) => createFolder(`${prefix} Folder ${i + 1}`)
            )
        ).filter(Boolean);

        const programs = (
            await pooled(
                Array.from({ length: programCount }, (_, i) => i),
                (i) => createProgram(`${prefix} Program ${String(i + 1).padStart(2, "0")}`)
            )
        ).filter(Boolean);

        const toFile = programs.slice(loose);
        let moveFailures = 0;
        if (folders.length) {
            const moves = await pooled(toFile, (programId, i) =>
                moveToFolder(programId, folders[i % folders.length])
            );
            moveFailures = moves.filter((res) => !res.ok).length;
        }

        // createFolder/createProgram already warn per item; this is the summary,
        // so a partial seed is obvious rather than silently short.
        const missing =
            folderCount - folders.length + (programCount - programs.length);
        if (missing || moveFailures) {
            console.warn(
                `${missing} item(s) could not be created and ` +
                    `${moveFailures} move(s) failed — the seed is incomplete.`
            );
        }

        console.log(
            `Done: ${folders.length} folders, ${programs.length} programs, ` +
                `${toFile.length} filed into folders. Reload the page to see them.`
        );
        return { folders, programs };
    };

    // The grid is virtualised: querying .ag-row only ever returns the handful of
    // rows currently scrolled into view (19 of 87, in one measurement). Anything
    // that wants every id has to scroll the viewport and collect as it goes.
    async function collectRowIds() {
        const viewport = document.querySelector(".ag-body-viewport");
        if (!viewport) return [];

        const originalScrollTop = viewport.scrollTop;
        const step = Math.max(viewport.clientHeight - ROW_HEIGHT_PX, ROW_HEIGHT_PX);
        const maxScroll = () =>
            Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        const ids = new Set();

        const limit = Math.ceil(maxScroll() / step) + 2;
        for (let i = 0, top = 0; i < limit; i += 1, top += step) {
            viewport.scrollTop = top;
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            );
            document.querySelectorAll(".ag-row").forEach((row) => {
                const id = (row.getAttribute("row-id") || "").replace("item-", "");
                if (/^\d+$/.test(id)) ids.add(id);
            });
            if (top >= maxScroll()) break;
        }

        viewport.scrollTop = originalScrollTop;
        return Array.from(ids);
    }

    // Deletes every row on the current page, folders included. Two reasons it may
    // need a second run: the grid paginates (50 rows by default) so later pages
    // are out of reach, and programs inside a deleted folder move back to the top
    // level rather than being destroyed.
    window.deleteEverything = async function deleteEverything() {
        const ids = await collectRowIds();
        console.log(`Deleting ${ids.length} items…`);

        const outcomes = await pooled(ids, async (id) => ({
            id,
            ok: (await post(ENDPOINTS.deleteItem, { program: id, method: "delete_sandbox" })).ok,
        }));
        const failed = outcomes.filter((outcome) => !outcome.ok).map((o) => o.id);

        if (failed.length) {
            console.warn(`${failed.length} deletions failed:`, failed);
        }
        console.log(
            `Deleted ${ids.length - failed.length}. Reload; run again if rows remain.`
        );
        return { deleted: ids.length - failed.length, failed };
    };

    console.log(
        "Loaded. seedTestData() for 5 folders + 40 programs, deleteEverything() to clear."
    );
})();
