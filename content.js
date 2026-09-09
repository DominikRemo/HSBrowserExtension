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

(() => {
    "use strict";

    const GRID_SELECTOR = ".sandbox-programs-grid";
    const ROW_ID_PREFIX = "item-";
    const DELETE_URL = "https://codehs.com/library/ajax/delete_sandbox";

    // Every class this script owns, in one place: each is referenced from the
    // DOM we build, the queries that find it again, and often the stylesheet too.
    const CLASS = {
        toolbarButton: "sandbox-delete-selected-button",
        toolbarLabel: "sandbox-delete-selected-label",
        rowCheckbox: "sandbox-checkbox",
        selectAllCheckbox: "sandbox-select-all-checkbox",
        headerLayer: "sandbox-header-overlay",
        bodyLayer: "sandbox-selection-overlay",
        styleElement: "sandbox-bulk-delete-styles",
    };

    // AG Grid's row height. The select-all walk steps by just under a viewport so
    // consecutive screens overlap by one row and nothing is skipped.
    const ROW_HEIGHT_PX = 56;
    // Used to centre a checkbox that has not been laid out yet, so its first
    // placement is not a frame off.
    const CHECKBOX_HEIGHT_PX = 14;
    // The checkbox sits this far into the row; the name column is indented far
    // enough to clear it. Change one and the other has to follow.
    const CHECKBOX_LEFT_PX = 6;
    const NAME_COLUMN_INDENT_PX = 28;

    const selected = new Set();
    // Whether the current selection came from "select all". Individual ticks
    // cannot prove every off-screen row is selected, so only this justifies
    // showing the header checkbox as fully checked rather than indeterminate.
    let selectAllActive = false;

    // --- observer ------------------------------------------------------------

    // The grid mounts asynchronously and recycles its rows on every scroll, sort
    // and filter, so an observer keeps everything in sync. Two things keep that
    // observer from starving the page, both learned the hard way:
    //
    //   * It is disconnected while we write to the DOM, so our own edits can never
    //     wake it and feed back into another pass.
    //   * Passes are coalesced onto one animation frame. AG Grid emits a burst of
    //     mutations per render, and running a pass per mutation left no frame
    //     budget for anything else — during a "select all" scroll the awaited
    //     frames never arrived and the page locked up.
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
            syncOverlays();
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

    // Holds the observer off entirely while we drive the grid ourselves.
    function suspendObserver() {
        suspended += 1;
        observer.disconnect();
    }

    function resumeObserver() {
        suspended = Math.max(0, suspended - 1);
        if (suspended === 0) observe();
    }

    // --- grid helpers --------------------------------------------------------

    function getCSRFToken() {
        const token = document.cookie
            .split("; ")
            .find((row) => row.startsWith("csrftoken="));
        return token ? token.split("=")[1] : "";
    }

    // Resolves to whether the item is actually gone. A rejected request and an
    // HTTP error both count as failure, so callers cannot mistake either for
    // success — fetch alone resolves happily on a 500.
    async function deleteItem(id) {
        try {
            const res = await fetch(DELETE_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-CSRFToken": getCSRFToken(),
                },
                body: `program=${id}&method=delete_sandbox`,
            });
            return res.ok;
        } catch (e) {
            return false;
        }
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

    // --- selection -----------------------------------------------------------

    // Walks the whole virtualised list so "select all" also covers rows that were
    // never scrolled into view, then restores the original scroll position.
    //
    // Scope note: this covers the current *page*. The grid paginates (50 rows by
    // default), and rows on other pages are not in the DOM at any scroll offset,
    // so they cannot be reached this way.
    async function forEachRowByScrolling(callback) {
        const viewport = getViewport();
        if (!viewport) return;

        const originalScrollTop = viewport.scrollTop;
        const step = Math.max(viewport.clientHeight - ROW_HEIGHT_PX, ROW_HEIGHT_PX);
        const seen = new Set();
        const maxScroll = () =>
            Math.max(0, viewport.scrollHeight - viewport.clientHeight);

        // The observer must stay off for the whole walk: it would otherwise fire
        // on every row AG Grid renders as we scroll and starve the frames this
        // loop is waiting on.
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
        selectAllActive = selected.size > 0;
        enhanceAll();
    }

    function clearSelection() {
        selected.clear();
        selectAllActive = false;
        enhanceAll();
    }

    async function deleteSelected() {
        const ids = Array.from(selected);
        if (ids.length === 0) return;

        const button = document.querySelector(`.${CLASS.toolbarButton}`);
        if (button) button.disabled = true;

        const outcomes = await Promise.all(
            ids.map(async (id) => ({ id, ok: await deleteItem(id) }))
        );
        const failed = outcomes.filter((outcome) => !outcome.ok).map((o) => o.id);

        if (failed.length === 0) {
            window.location.reload();
            return;
        }

        // Leave the page standing so the failure is visible and retryable, with
        // only the items that actually failed still selected.
        console.error(
            `[Hacker School Utils] ${failed.length} of ${ids.length} deletions failed:`,
            failed
        );
        selected.clear();
        failed.forEach((id) => selected.add(id));
        selectAllActive = false;
        enhanceAll();

        const retry = document.querySelector(`.${CLASS.toolbarButton}`);
        if (retry) {
            retry.disabled = false;
            retry.title = `${failed.length} could not be deleted — still selected, try again`;
        }
    }

    // --- toolbar -------------------------------------------------------------

    function updateToolbar() {
        const button = document.querySelector(`.${CLASS.toolbarButton}`);
        if (button) {
            button.disabled = selected.size === 0;
            button.querySelector(`.${CLASS.toolbarLabel}`).textContent =
                selected.size === 0
                    ? "Delete selected"
                    : `Delete selected (${selected.size})`;
        }

        const selectAllBox = document.querySelector(`.${CLASS.selectAllCheckbox}`);
        if (selectAllBox) {
            // Ticking every visible row does not mean every row is selected, so
            // only an actual "select all" shows as fully checked.
            selectAllBox.checked = selectAllActive && selected.size > 0;
            selectAllBox.indeterminate = !selectAllBox.checked && selected.size > 0;
        }
    }

    function setupToolbar() {
        const bar =
            document.querySelector(".sandbox-programs-controls") ||
            document.querySelector(".sandbox-programs-bar");
        if (!bar || bar.querySelector(`.${CLASS.toolbarButton}`)) return;

        // CodeHS styles its own toolbar buttons as `btn btn-main-white btn-sm`
        // with a leading Font Awesome icon; matching that keeps ours from looking
        // bolted on.
        const button = document.createElement("button");
        button.type = "button";
        button.className = `btn btn-main-white btn-sm ${CLASS.toolbarButton}`;
        button.disabled = true;

        const icon = document.createElement("span");
        icon.className = "fas fa-trash";
        icon.setAttribute("aria-hidden", "true");

        const label = document.createElement("span");
        label.className = CLASS.toolbarLabel;
        label.textContent = "Delete selected";

        button.append(icon, label);
        button.addEventListener("click", (e) => {
            e.preventDefault();
            deleteSelected();
        });

        bar.appendChild(button);
        updateToolbar();
    }

    // --- checkbox overlays ---------------------------------------------------

    // The overlays deliberately hang off the outer .sandbox-programs-grid wrapper
    // rather than off AG Grid's own row/header containers. AG Grid rebuilds the
    // children of those containers on every render, which removed the overlay,
    // which woke the observer, which put it back — a mutual-recursion loop that
    // pegged the page. The wrapper is ours to append to and is never rebuilt.
    //
    // There are two layers, each clipped to the band of the grid it belongs to:
    // the header, and the scrolling body. Clipping the body layer to the viewport
    // is what stops a control belonging to a half-scrolled row from being drawn
    // over the pagination footer below it.
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
            // Only the checkboxes themselves should swallow clicks; the rest of
            // the grid must stay clickable.
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
        const half = (el.offsetHeight || CHECKBOX_HEIGHT_PX) / 2;
        el.style.top = `${rect.top - layerRect.top + rect.height / 2 - half}px`;
    }

    function makeCheckbox(className) {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = className;
        checkbox.style.position = "absolute";
        checkbox.style.left = `${CHECKBOX_LEFT_PX}px`;
        checkbox.style.pointerEvents = "auto";
        checkbox.style.cursor = "pointer";
        return checkbox;
    }

    function syncHeaderCheckbox(wrapperRect) {
        const headerRow = document.querySelector(`${GRID_SELECTOR} .ag-header-row`);
        if (!headerRow) return;

        const headerRect = headerRow.getBoundingClientRect();
        const layer = getOverlayLayer(CLASS.headerLayer, headerRect, wrapperRect);
        if (!layer) return;

        let selectAllBox = layer.querySelector(`.${CLASS.selectAllCheckbox}`);
        if (!selectAllBox) {
            selectAllBox = makeCheckbox(CLASS.selectAllCheckbox);
            selectAllBox.title = "Select all";
            selectAllBox.addEventListener("change", () => {
                if (selectAllBox.checked) selectAll();
                else clearSelection();
            });
            layer.appendChild(selectAllBox);
        }
        placeAt(selectAllBox, headerRect, layer.getBoundingClientRect());
    }

    function syncRowCheckboxes(wrapperRect, viewport) {
        const layer = getOverlayLayer(
            CLASS.bodyLayer,
            viewport.getBoundingClientRect(),
            wrapperRect
        );
        if (!layer) return;
        const layerRect = layer.getBoundingClientRect();

        const live = new Set();
        renderedRows().forEach((row) => {
            const id = itemIdOf(row);
            if (!id) return;
            live.add(id);

            let checkbox = layer.querySelector(`[data-item-id="${id}"]`);
            if (!checkbox) {
                checkbox = makeCheckbox(CLASS.rowCheckbox);
                checkbox.dataset.itemId = id;
                checkbox.addEventListener("change", () => {
                    if (checkbox.checked) {
                        selected.add(id);
                    } else {
                        selected.delete(id);
                        // The selection is no longer "everything".
                        selectAllActive = false;
                    }
                    updateToolbar();
                });
                layer.appendChild(checkbox);
            }
            placeAt(checkbox, row.getBoundingClientRect(), layerRect);
            checkbox.checked = selected.has(id);
        });

        // Drop checkboxes whose row has been recycled out of view.
        layer.querySelectorAll(`.${CLASS.rowCheckbox}`).forEach((checkbox) => {
            if (!live.has(checkbox.dataset.itemId)) checkbox.remove();
        });
    }

    function syncOverlays() {
        const wrapper = document.querySelector(GRID_SELECTOR);
        const viewport = getViewport();
        if (!wrapper || !viewport) return;

        const wrapperRect = wrapper.getBoundingClientRect();
        syncHeaderCheckbox(wrapperRect);
        syncRowCheckboxes(wrapperRect, viewport);
    }

    // Indent the name column so the overlay checkboxes have space of their own
    // instead of sitting on top of the program names. A stylesheet is safe where
    // DOM edits are not, because it does not touch the React-rendered cells.
    function setupStyles() {
        if (document.getElementById(CLASS.styleElement)) return;
        const style = document.createElement("style");
        style.id = CLASS.styleElement;
        style.textContent = `
            ${GRID_SELECTOR} .ag-center-cols-container .ag-cell[col-id="name"],
            ${GRID_SELECTOR} .ag-header-cell[col-id="name"] {
                padding-left: ${NAME_COLUMN_INDENT_PX}px;
            }
            .${CLASS.toolbarButton}:not([disabled]) {
                color: #c9302c;
            }
            .${CLASS.toolbarButton} .${CLASS.toolbarLabel} {
                margin-left: 6px;
            }
        `;
        document.head.appendChild(style);
    }

    // --- setup ---------------------------------------------------------------

    // Row positions are measured from the viewport, so they must be refreshed on
    // scroll as well as on mutation.
    document.addEventListener("scroll", scheduleEnhance, {
        capture: true,
        passive: true,
    });
    window.addEventListener("resize", scheduleEnhance, { passive: true });

    observe();
    enhanceAll();
})();
