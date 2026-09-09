// Content script for CodeHS bulk delete functionality
//
// CodeHS replaced the old plain <table> program list with an AG Grid
// (.sandbox-programs-grid, theme ag-theme-quartz). Three consequences drive the
// design here:
//
//   * There are no <table>/<tr> elements any more. Rows are div[role="row"].ag-row
//     and the program id lives in row-id="item-<id>" rather than data-program-id.
//   * The grid is virtualised: only the rows currently scrolled into view exist in
//     the DOM, and they are recycled as you scroll. Selection therefore lives in a
//     Set keyed by program id, and checkbox state is re-applied whenever a row is
//     rendered. "Select all" has to walk the viewport to learn the ids it cannot see.
//   * The cells are rendered by React components. Inserting a checkbox into a cell
//     corrupts React's reconciliation and the program name disappears on the next
//     re-render, so the checkboxes live in an overlay layer that is positioned over
//     the rows instead of inside them. AG Grid owns the row containers imperatively,
//     which makes the container — unlike the cells — safe to append to.
//   * Folders and programs share one grid, told apart only by the type column.
//     Only programs are deletable here — the folder delete endpoint is different
//     and is deliberately not touched.
//
// The delete request itself is unchanged from the previous CodeHS client.

const GRID_SELECTOR = ".sandbox-programs-grid";
const ROW_ID_PREFIX = "item-";

const selected = new Set();

function getCSRFToken() {
    const token = document.cookie
        .split("; ")
        .find((row) => row.startsWith("csrftoken="));
    return token ? token.split("=")[1] : "";
}

function deleteProgram(programId) {
    return fetch("https://codehs.com/library/ajax/delete_sandbox", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-CSRFToken": getCSRFToken(),
        },
        body: `program=${programId}&method=delete_sandbox`,
    });
}

// row-id is "item-24021934"; the delete endpoint wants the bare number.
function programIdOf(row) {
    const rowId = row.getAttribute("row-id");
    if (!rowId || !rowId.startsWith(ROW_ID_PREFIX)) return null;
    const id = rowId.slice(ROW_ID_PREFIX.length);
    return /^\d+$/.test(id) ? id : null;
}

function isFolder(row) {
    const typeCell = row.querySelector('[col-id="type"]');
    return typeCell ? typeCell.textContent.trim() === "Folder" : false;
}

function getViewport() {
    return document.querySelector(`${GRID_SELECTOR} .ag-body-viewport`);
}

// --- toolbar ---------------------------------------------------------------

function updateToolbar() {
    const button = document.querySelector(".sandbox-delete-selected-button");
    if (!button) return;
    button.disabled = selected.size === 0;
    button.querySelector(".sandbox-delete-selected-label").textContent =
        selected.size === 0 ? "Delete selected" : `Delete selected (${selected.size})`;
}

function createToolbarButton(className, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn btn-sm ${className}`;
    button.textContent = label;
    button.addEventListener("click", (e) => {
        e.preventDefault();
        onClick();
    });
    return button;
}

// Walks the whole virtualised list so "select all" also covers rows that were
// never scrolled into view, then restores the original scroll position.
async function forEachRowByScrolling(callback) {
    const viewport = getViewport();
    if (!viewport) return;

    const originalScrollTop = viewport.scrollTop;
    const step = Math.max(viewport.clientHeight - 56, 56);
    const seen = new Set();

    for (let top = 0; ; top += step) {
        viewport.scrollTop = top;
        // Give AG Grid a frame to render the rows for this scroll offset.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        document.querySelectorAll(`${GRID_SELECTOR} .ag-row`).forEach((row) => {
            const id = programIdOf(row);
            if (id && !seen.has(id)) {
                seen.add(id);
                callback(row, id);
            }
        });

        if (top >= viewport.scrollHeight - viewport.clientHeight) break;
    }

    viewport.scrollTop = originalScrollTop;
}

async function selectAll() {
    await forEachRowByScrolling((row, id) => {
        if (!isFolder(row)) selected.add(id);
    });
    syncRenderedCheckboxes();
    updateToolbar();
}

function clearSelection() {
    selected.clear();
    syncRenderedCheckboxes();
    updateToolbar();
}

async function deleteSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;

    const button = document.querySelector(".sandbox-delete-selected-button");
    if (button) button.disabled = true;

    await Promise.all(ids.map((id) => deleteProgram(id)));
    window.location.reload();
}

function setupToolbar() {
    const bar = document.querySelector(".sandbox-programs-controls") ||
        document.querySelector(".sandbox-programs-bar");
    if (!bar || bar.querySelector(".sandbox-delete-selected-button")) return;

    const selectAllButton = createToolbarButton(
        "btn-default sandbox-select-all-button",
        "Select all",
        selectAll
    );

    const clearButton = createToolbarButton(
        "btn-default sandbox-clear-selection-button",
        "Clear",
        clearSelection
    );

    const deleteButton = createToolbarButton(
        "btn-danger sandbox-delete-selected-button",
        "",
        deleteSelected
    );
    const label = document.createElement("span");
    label.className = "sandbox-delete-selected-label";
    label.textContent = "Delete selected";
    deleteButton.appendChild(label);
    deleteButton.disabled = true;

    bar.append(selectAllButton, clearButton, deleteButton);
    updateToolbar();
}

// --- rows ------------------------------------------------------------------

// Rows are absolutely positioned by AG Grid via `transform: translateY(<n>px)`,
// so the overlay can mirror them exactly by reading that offset back.
function rowOffsetTop(row) {
    const match = /translateY\((-?[\d.]+)px\)/.exec(row.style.transform || "");
    return match ? parseFloat(match[1]) : row.offsetTop;
}

function getOverlay() {
    const container = document.querySelector(
        `${GRID_SELECTOR} .ag-center-cols-container`
    );
    if (!container) return null;

    let overlay = container.querySelector(".sandbox-selection-overlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "sandbox-selection-overlay";
        overlay.style.position = "absolute";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.width = "24px";
        overlay.style.height = "100%";
        // Only the checkboxes themselves should swallow clicks; the rest of the
        // row must stay clickable.
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "1";
        container.appendChild(overlay);
    }
    return overlay;
}

function syncRenderedCheckboxes() {
    const overlay = getOverlay();
    if (!overlay) return;

    const rows = document.querySelectorAll(`${GRID_SELECTOR} .ag-row`);
    const live = new Set();

    rows.forEach((row) => {
        const id = programIdOf(row);
        // Folders share the grid but are not deletable through this endpoint.
        if (!id || isFolder(row)) return;
        live.add(id);

        let checkbox = overlay.querySelector(`[data-program-id="${id}"]`);
        if (!checkbox) {
            checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "sandbox-checkbox";
            checkbox.dataset.programId = id;
            checkbox.style.position = "absolute";
            checkbox.style.left = "6px";
            checkbox.style.pointerEvents = "auto";
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selected.add(id);
                else selected.delete(id);
                updateToolbar();
            });
            overlay.appendChild(checkbox);
        }

        checkbox.style.top = `${rowOffsetTop(row) + row.offsetHeight / 2 - 7}px`;
        checkbox.checked = selected.has(id);
    });

    // Drop checkboxes whose row has been recycled out of view.
    overlay.querySelectorAll(".sandbox-checkbox").forEach((checkbox) => {
        if (!live.has(checkbox.dataset.programId)) checkbox.remove();
    });
}

// Indent the name column so the overlay checkboxes do not sit on top of the
// program names. A stylesheet is safe where DOM edits are not, because it does
// not touch the React-rendered cell contents.
function setupStyles() {
    if (document.getElementById("sandbox-bulk-delete-styles")) return;
    const style = document.createElement("style");
    style.id = "sandbox-bulk-delete-styles";
    style.textContent = `
        ${GRID_SELECTOR} .ag-center-cols-container .ag-cell[col-id="name"],
        ${GRID_SELECTOR} .ag-header-cell[col-id="name"] {
            padding-left: 28px;
        }
    `;
    document.head.appendChild(style);
}

function enhanceAll() {
    setupStyles();
    setupToolbar();
    syncRenderedCheckboxes();
}

// --- setup -----------------------------------------------------------------

// The grid mounts asynchronously and recycles its rows on every scroll, sort and
// filter, so a single observer over the document keeps everything in sync.
const observer = new MutationObserver(() => {
    if (document.querySelector(GRID_SELECTOR)) enhanceAll();
});

observer.observe(document, { childList: true, subtree: true });
enhanceAll();
