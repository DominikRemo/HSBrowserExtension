// Content script for CodeHS bulk delete functionality
//
// CodeHS replaced the old plain <table> program list with an AG Grid
// (.sandbox-programs-grid, theme ag-theme-quartz). Three consequences drive the
// design here:
//
//   * There are no <table>/<tr> elements any more. Rows are div[role="row"].ag-row
//     and the item id lives in row-id="item-<id>" rather than data-program-id.
//     Folders and programs share the one grid and the one delete endpoint, so both
//     are selectable. Deleting a folder moves the programs inside it back to the
//     top level rather than destroying them, which is CodeHS's own behaviour.
//   * The grid is virtualised: only the rows currently scrolled into view exist in
//     the DOM, and they are recycled as you scroll. Selection therefore lives in a
//     Set keyed by id, and checkbox state is re-applied whenever a row is rendered.
//     "Select all" has to walk the viewport to learn the ids it cannot see.
//   * The cells are rendered by React components. Inserting a checkbox into a cell
//     corrupts React's reconciliation and the program name disappears on the next
//     re-render, so the checkboxes live in overlay layers positioned over the rows
//     and the header instead of inside them. AG Grid owns those containers
//     imperatively, which makes them — unlike the cells — safe to append to.
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

function deleteItem(id) {
    return fetch("https://codehs.com/library/ajax/delete_sandbox", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-CSRFToken": getCSRFToken(),
        },
        body: `program=${id}&method=delete_sandbox`,
    });
}

// row-id is "item-24021934"; the delete endpoint wants the bare number.
function itemIdOf(row) {
    const rowId = row.getAttribute("row-id");
    if (!rowId || !rowId.startsWith(ROW_ID_PREFIX)) return null;
    const id = rowId.slice(ROW_ID_PREFIX.length);
    return /^\d+$/.test(id) ? id : null;
}

function getViewport() {
    return document.querySelector(`${GRID_SELECTOR} .ag-body-viewport`);
}

function renderedRows() {
    return Array.from(document.querySelectorAll(`${GRID_SELECTOR} .ag-row`));
}

// --- toolbar ---------------------------------------------------------------

function updateToolbar() {
    const button = document.querySelector(".sandbox-delete-selected-button");
    if (button) {
        button.disabled = selected.size === 0;
        button.querySelector(".sandbox-delete-selected-label").textContent =
            selected.size === 0
                ? "Delete selected"
                : `Delete selected (${selected.size})`;
    }

    const selectAllBox = document.querySelector(".sandbox-select-all-checkbox");
    if (selectAllBox) {
        const ids = renderedRows().map(itemIdOf).filter(Boolean);
        const allChecked = ids.length > 0 && ids.every((id) => selected.has(id));
        selectAllBox.checked = selected.size > 0 && allChecked;
        selectAllBox.indeterminate = selected.size > 0 && !allChecked;
    }
}

// CodeHS styles its own toolbar buttons as `btn btn-main-white btn-sm` with a
// leading Font Awesome icon, so ours are built the same way to sit in the row
// without looking bolted on.
function createToolbarButton(className, iconClass, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn btn-main-white btn-sm ${className}`;

    const icon = document.createElement("span");
    icon.className = iconClass;
    icon.setAttribute("aria-hidden", "true");
    button.appendChild(icon);

    const text = document.createElement("span");
    text.className = "sandbox-delete-selected-label";
    text.textContent = label;
    button.appendChild(text);

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
    const maxScroll = () =>
        Math.max(0, viewport.scrollHeight - viewport.clientHeight);

    // The observer must stay off for the whole walk: it would otherwise fire on
    // every row AG Grid renders as we scroll and starve the frames this loop is
    // waiting on.
    suspendObserver();
    try {
        // Bounded by the row count so a mis-measured viewport can never spin.
        const limit = Math.ceil(maxScroll() / step) + 2;

        for (let i = 0, top = 0; i < limit; i += 1, top += step) {
            viewport.scrollTop = top;
            // Give AG Grid a frame to render the rows for this scroll offset.
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            );

            renderedRows().forEach((row) => {
                const id = itemIdOf(row);
                if (id && !seen.has(id)) {
                    seen.add(id);
                    callback(row, id);
                }
            });

            if (top >= maxScroll()) break;
        }

        viewport.scrollTop = originalScrollTop;
    } finally {
        resumeObserver();
    }
}

async function selectAll() {
    await forEachRowByScrolling((row, id) => selected.add(id));
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

    await Promise.all(ids.map((id) => deleteItem(id)));
    window.location.reload();
}

function setupToolbar() {
    const bar =
        document.querySelector(".sandbox-programs-controls") ||
        document.querySelector(".sandbox-programs-bar");
    if (!bar || bar.querySelector(".sandbox-delete-selected-button")) return;

    const deleteButton = createToolbarButton(
        "sandbox-delete-selected-button",
        "fas fa-trash",
        "Delete selected",
        deleteSelected
    );
    deleteButton.disabled = true;

    bar.appendChild(deleteButton);
    updateToolbar();
}

// --- checkbox overlays -----------------------------------------------------

// The overlays deliberately hang off the outer .sandbox-programs-grid wrapper
// rather than off AG Grid's own row/header containers. AG Grid rebuilds the
// children of those containers on every render, which removed the overlay, which
// woke the observer, which put it back — a mutual-recursion loop that pegged the
// page. The wrapper is ours to append to and is never rebuilt.
//
// There are two layers, each clipped to the band of the grid it belongs to: the
// header, and the scrolling body. Clipping the body layer to the viewport is what
// stops a control belonging to a half-scrolled row from being drawn over the
// pagination footer below it.
function getOverlayLayer(className, rect, wrapperRect) {
    const wrapper = document.querySelector(GRID_SELECTOR);
    if (!wrapper || !rect) return null;

    if (getComputedStyle(wrapper).position === "static") {
        wrapper.style.position = "relative";
    }

    let layer = wrapper.querySelector(`:scope > .${className}`);
    if (!layer) {
        layer = document.createElement("div");
        layer.className = className;
        layer.style.position = "absolute";
        layer.style.left = "0";
        layer.style.width = "100%";
        layer.style.overflow = "hidden";
        // Only the controls themselves should swallow clicks; the rest of the
        // grid must stay clickable.
        layer.style.pointerEvents = "none";
        layer.style.zIndex = "1";
        wrapper.appendChild(layer);
    }

    layer.style.top = `${rect.top - wrapperRect.top}px`;
    layer.style.height = `${rect.height}px`;
    return layer;
}

// Positions are measured against the layer the control lives in, so they stay
// correct whether the grid scrolls, sorts or re-renders.
function placeAt(el, rect, layerRect) {
    const half = (el.offsetHeight || 14) / 2;
    el.style.top = `${rect.top - layerRect.top + rect.height / 2 - half}px`;
}

function makeCheckbox(className) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = className;
    checkbox.style.position = "absolute";
    checkbox.style.left = "6px";
    checkbox.style.pointerEvents = "auto";
    checkbox.style.cursor = "pointer";
    return checkbox;
}

function syncRenderedCheckboxes() {
    const wrapper = document.querySelector(GRID_SELECTOR);
    const viewport = getViewport();
    if (!wrapper || !viewport) return;
    const wrapperRect = wrapper.getBoundingClientRect();

    // Header select-all, clipped to the header band.
    const headerRow = document.querySelector(`${GRID_SELECTOR} .ag-header-row`);
    if (headerRow) {
        const headerRect = headerRow.getBoundingClientRect();
        const headerLayer = getOverlayLayer(
            "sandbox-header-overlay",
            headerRect,
            wrapperRect
        );
        if (headerLayer) {
            let selectAllBox = headerLayer.querySelector(".sandbox-select-all-checkbox");
            if (!selectAllBox) {
                selectAllBox = makeCheckbox("sandbox-select-all-checkbox");
                selectAllBox.title = "Select all";
                selectAllBox.addEventListener("change", () => {
                    if (selectAllBox.checked) selectAll();
                    else clearSelection();
                });
                headerLayer.appendChild(selectAllBox);
            }
            placeAt(selectAllBox, headerRect, headerLayer.getBoundingClientRect());
        }
    }

    // A checkbox and a delete button per rendered row, clipped to the scrolling
    // body so nothing bleeds over the pagination footer.
    const overlay = getOverlayLayer(
        "sandbox-selection-overlay",
        viewport.getBoundingClientRect(),
        wrapperRect
    );
    if (!overlay) return;
    const layerRect = overlay.getBoundingClientRect();

    const live = new Set();
    renderedRows().forEach((row) => {
        const id = itemIdOf(row);
        if (!id) return;
        live.add(id);
        const rowRect = row.getBoundingClientRect();

        let checkbox = overlay.querySelector(`[data-item-id="${id}"]`);
        if (!checkbox) {
            checkbox = makeCheckbox("sandbox-checkbox");
            checkbox.dataset.itemId = id;
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selected.add(id);
                else selected.delete(id);
                updateToolbar();
            });
            overlay.appendChild(checkbox);
        }
        placeAt(checkbox, rowRect, layerRect);
        checkbox.checked = selected.has(id);

        // The per-row delete button sits in the space the stylesheet reserves at
        // the head of the actions column, beside CodeHS's own "..." menu.
        const actionsCell = row.querySelector('[col-id="actions"]');
        if (!actionsCell) return;

        let rowDelete = overlay.querySelector(`[data-delete-for="${id}"]`);
        if (!rowDelete) {
            rowDelete = document.createElement("button");
            rowDelete.type = "button";
            rowDelete.className = "sandbox-row-delete-button";
            rowDelete.dataset.deleteFor = id;
            rowDelete.title = "Delete";
            rowDelete.setAttribute("aria-label", "Delete");
            const icon = document.createElement("span");
            icon.className = "fas fa-trash";
            icon.setAttribute("aria-hidden", "true");
            rowDelete.appendChild(icon);
            rowDelete.addEventListener("click", async (e) => {
                e.preventDefault();
                rowDelete.disabled = true;
                await deleteItem(id);
                window.location.reload();
            });
            overlay.appendChild(rowDelete);
        }

        const actionsRect = actionsCell.getBoundingClientRect();
        rowDelete.style.left = `${actionsRect.left - layerRect.left + 4}px`;
        placeAt(rowDelete, rowRect, layerRect);
    });

    // Drop controls whose row has been recycled out of view.
    overlay
        .querySelectorAll(".sandbox-checkbox, .sandbox-row-delete-button")
        .forEach((el) => {
            const id = el.dataset.itemId || el.dataset.deleteFor;
            if (!live.has(id)) el.remove();
        });
}

// Indent the name and actions columns so the overlay controls have space of
// their own instead of sitting on top of the names and CodeHS's "..." menu. A
// stylesheet is safe where DOM edits are not, because it does not touch the
// React-rendered cell contents.
function setupStyles() {
    if (document.getElementById("sandbox-bulk-delete-styles")) return;
    const style = document.createElement("style");
    style.id = "sandbox-bulk-delete-styles";
    style.textContent = `
        ${GRID_SELECTOR} .ag-center-cols-container .ag-cell[col-id="name"],
        ${GRID_SELECTOR} .ag-header-cell[col-id="name"] {
            padding-left: 28px;
        }
        ${GRID_SELECTOR} .ag-center-cols-container .ag-cell[col-id="actions"] {
            padding-left: 28px;
        }
        .sandbox-row-delete-button {
            /* The overlay is pointer-events:none so the grid stays clickable
               through it; each control has to opt back in. Without the absolute
               position the top/left set per row would also be ignored. */
            position: absolute;
            pointer-events: auto;
            background: none;
            border: 0;
            padding: 4px 6px;
            line-height: 1;
            color: #c9302c;
            cursor: pointer;
            border-radius: 4px;
        }
        .sandbox-row-delete-button:hover {
            background: rgba(201, 48, 44, 0.12);
        }
        .sandbox-row-delete-button[disabled] {
            opacity: 0.5;
            cursor: default;
        }
        .sandbox-delete-selected-button:not([disabled]) {
            color: #c9302c;
        }
        .sandbox-delete-selected-button .sandbox-delete-selected-label {
            margin-left: 6px;
        }
    `;
    document.head.appendChild(style);
}

// --- setup -----------------------------------------------------------------

// The grid mounts asynchronously and recycles its rows on every scroll, sort and
// filter, so an observer keeps everything in sync. Two things keep that observer
// from starving the page, both learned the hard way:
//
//   * It is disconnected while we write to the DOM, so our own edits can never
//     wake it and feed back into another pass.
//   * Passes are coalesced onto one animation frame. AG Grid emits a burst of
//     mutations per render, and running a pass per mutation left no frame budget
//     for anything else — during a "select all" scroll the awaited frames never
//     arrived and the page locked up.
const observer = new MutationObserver(scheduleEnhance);
let scheduled = false;
let suspended = 0;

function observe() {
    observer.observe(document, { childList: true, subtree: true });
}

function enhanceAll() {
    if (suspended > 0) return;
    observer.disconnect();
    try {
        setupStyles();
        setupToolbar();
        syncRenderedCheckboxes();
        updateToolbar();
    } finally {
        observe();
    }
}

function scheduleEnhance() {
    if (scheduled || suspended > 0) return;
    scheduled = true;
    requestAnimationFrame(() => {
        scheduled = false;
        if (document.querySelector(GRID_SELECTOR)) enhanceAll();
    });
}

// Used to hold the observer off entirely while we drive the grid ourselves.
function suspendObserver() {
    suspended += 1;
    observer.disconnect();
}

function resumeObserver() {
    suspended = Math.max(0, suspended - 1);
    if (suspended === 0) observe();
}

// Row positions are measured from the viewport, so they must be refreshed on
// scroll as well as on mutation.
document.addEventListener("scroll", scheduleEnhance, { capture: true, passive: true });
window.addEventListener("resize", scheduleEnhance, { passive: true });

observe();
enhanceAll();
