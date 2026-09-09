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
        if (folders.length) {
            await pooled(toFile, (programId, i) =>
                moveToFolder(programId, folders[i % folders.length])
            );
        }

        console.log(
            `Done: ${folders.length} folders, ${programs.length} programs, ` +
                `${toFile.length} filed into folders. Reload the page to see them.`
        );
        return { folders, programs };
    };

    // Deletes every row currently in the grid, folders included. Programs inside
    // a deleted folder move back to the top level rather than being destroyed, so
    // this may need a second run to fully empty the sandbox.
    window.deleteEverything = async function deleteEverything() {
        const ids = Array.from(document.querySelectorAll(".ag-row"))
            .map((row) => (row.getAttribute("row-id") || "").replace("item-", ""))
            .filter((id) => /^\d+$/.test(id));

        console.log(`Deleting ${ids.length} visible items…`);
        await pooled(ids, (id) =>
            post(ENDPOINTS.deleteItem, { program: id, method: "delete_sandbox" })
        );
        console.log("Done. Reload; run again if folders left programs behind.");
        return ids.length;
    };

    console.log(
        "Loaded. seedTestData() for 5 folders + 40 programs, deleteEverything() to clear."
    );
})();
