/* ============================================================
   Markdown Org Reader
   Renders a Markdown file's heading hierarchy as a d3-org-chart.
   Each section is a fixed-width card: prose wraps + scrolls
   vertically, wide tables scroll inside the box — never the page.
   ============================================================ */
(function () {
  "use strict";

  // ---- layout constants -------------------------------------------------
  const NODE_WIDTH = 360;   // matches .md-node width in CSS
  const BODY_MAX   = 360;   // max scrollable body height (px) before vertical scroll
  const HEADER_MIN = 44;

  // ---- state ------------------------------------------------------------
  let chart = null;
  let nodes = [];           // flat array used by org-chart + for search
  let curLayout = "top";
  let isCompact = false;
  let loadCount = 0;        // namespaces node ids per load (avoids cross-load id collisions)
  let currentMode = "mindmap"; // "mindmap" (org-chart) | "reader" (one whole document)
  let currentMd = "";       // raw markdown of the loaded doc (source for reader mode)
  let currentTitle = "";    // doc title (filename without extension)
  let parsedList = null;    // cached heading tree for the current doc
  let chartBuilt = false;   // org-chart is built lazily the first time mindmap mode shows

  // ---- marked config ----------------------------------------------------
  marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });

  const $ = (sel) => document.querySelector(sel);

  function chip(depth) { return depth === 0 ? "DOC" : "H" + depth; }
  function clampDepth(d) { return Math.min(d, 6); }

  function sanitize(html) {
    return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
  }

  // ---- 1. parse markdown into a heading tree ----------------------------
  function parseMarkdown(md, docTitle) {
    const tokens = marked.lexer(md);
    const sections = [];
    const preamble = [];
    let current = null;

    for (const t of tokens) {
      if (t.type === "heading") {
        current = { depth: t.depth, titleRaw: t.text, raw: "" };
        sections.push(current);
      } else if (current) {
        current.raw += t.raw;
      } else {
        preamble.push(t.raw);   // content before the first heading
      }
    }

    // build the tree via a depth stack. ids are namespaced per load so a new
    // document can never collide with the previous chart's node ids.
    const pre = "d" + (++loadCount) + "_n";
    const out = [];
    let seq = 0;
    const root = {
      id: pre + seq++, parentId: null, depth: 0,
      titleRaw: docTitle, raw: preamble.join(""),
    };
    out.push(root);
    const stack = [root];

    for (const s of sections) {
      while (stack.length > 1 && stack[stack.length - 1].depth >= s.depth) stack.pop();
      const parent = stack[stack.length - 1];
      const node = {
        id: pre + seq++, parentId: parent.id, depth: s.depth,
        titleRaw: s.titleRaw, raw: s.raw,
      };
      out.push(node);
      stack.push(node);
    }

    // render html + inline titles, wrap tables for contained scroll
    for (const n of out) {
      n.title = sanitize(marked.parseInline(n.titleRaw || "Untitled"));
      const body = (n.raw && n.raw.trim()) ? sanitize(marked.parse(n.raw)) : "";
      n.html = wrapTables(body);
    }
    return out;
  }

  // wrap every <table> in a horizontally-scrollable container
  function wrapTables(html) {
    if (!html || html.indexOf("<table") === -1) return html;
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    tmp.querySelectorAll("table").forEach((tbl) => {
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      tbl.parentNode.insertBefore(wrap, tbl);
      wrap.appendChild(tbl);
    });
    return tmp.innerHTML;
  }

  // ---- 2. pre-measure each node so boxes are tight, not uniform-empty ---
  function measure(list) {
    const hm = $("#measure-header");
    const bm = $("#measure-body");
    for (const n of list) {
      hm.innerHTML =
        `<span class="chip">${chip(clampDepth(n.depth))}</span>` +
        `<span class="title">${n.title || ""}</span>`;
      const headerH = Math.max(HEADER_MIN, hm.offsetHeight);

      let bodyH = 0;
      n.scroll = false;
      if (n.html) {
        bm.innerHTML = n.html;
        const full = bm.offsetHeight;
        bodyH = Math.min(BODY_MAX, full);
        n.scroll = full > BODY_MAX + 2;
      }
      n.headerH = headerH;
      n.bodyH = bodyH;
      // +2 for the card's top/bottom border (border-box on .md-node)
      n.height = headerH + bodyH + 2;
      // live, user-resizable dimensions (read by nodeWidth/nodeHeight accessors)
      n.width = NODE_WIDTH;
    }
  }

  // ---- 3. node renderer -------------------------------------------------
  function nodeContent(d) {
    const n = d.data;
    const dep = clampDepth(n.depth);
    // body is a flex child that fills the (resizable) card height and scrolls
    const body = n.bodyH ? `<div class="node-body">${n.html}</div>` : "";
    return (
      `<div class="md-node depth-${dep} ${n.scroll ? "is-scroll" : ""}" ` +
        `style="width:${n.width || NODE_WIDTH}px;height:${n.height}px" data-id="${n.id}">` +
        `<div class="node-header">` +
          `<span class="chip">${chip(dep)}</span>` +
          `<span class="title">${n.title || "Untitled"}</span>` +
        `</div>${body}` +
        `<div class="resize-handle" title="Drag to resize"></div>` +
      `</div>`
    );
  }

  function buttonContent({ node }) {
    const open = !!node.children;
    const count = node.data._directSubordinates || node.data._totalSubordinates || "";
    return (
      `<div class="oc-btn ${open ? "open" : ""}">` +
        `<span class="arrow">▶</span><span>${count}</span>` +
      `</div>`
    );
  }

  // ---- 4. build / refresh chart ----------------------------------------
  function renderChart(list) {
    nodes = list;
    measure(list);

    // Destroy any previous chart entirely. d3-org-chart reuses the svg + node
    // groups it finds in the container, which would keep the OLD instance's
    // expand/collapse handlers alive and snap back to the previous document.
    $("#chart").innerHTML = "";

    chart = new d3.OrgChart()
      .container("#chart")
      .data(list)
      .nodeWidth((d) => d.data.width || NODE_WIDTH)
      .nodeHeight((d) => d.data.height || 80)
      // Wheel = scroll the node under the cursor; wheel over empty canvas = zoom.
      // Ctrl/Cmd + wheel (and trackpad pinch) always zooms.
      .createZoom(() =>
        d3.zoom().filter((event) => {
          if (event.type === "wheel") {
            if (event.ctrlKey || event.metaKey) return true;
            return !(event.target.closest && event.target.closest(".node-body"));
          }
          return !event.button && !event.ctrlKey; // left-drag pans
        })
      )
      .childrenMargin(() => 60)
      .siblingsMargin(() => 28)
      .neighbourMargin(() => 28)
      .compactMarginBetween(() => 35)
      .compactMarginPair(() => 30)
      .compact(isCompact)
      .layout(curLayout)
      .scaleExtent([0.08, 2.5])
      .nodeContent(nodeContent)
      .buttonContent(buttonContent)
      .linkUpdate(function (d) {
        d3.select(this).attr("stroke", "var(--line-strong)").attr("stroke-width", 1.6);
      })
      .render();

    // A reader should show the whole outline by default.
    safe(() => chart.expandAll());
    chart.fit();
  }

  // ---- node resizing (drag the bottom-right handle) ---------------------
  function setupResize() {
    const stage = $("#chart");
    let drag = null;

    // capture phase so we intercept the mousedown before d3-zoom's pan starts
    stage.addEventListener("mousedown", (e) => {
      const handle = e.target.closest && e.target.closest(".resize-handle");
      if (!handle) return;
      const card = handle.closest(".md-node");
      const node = card && nodes.find((n) => n.id === card.dataset.id);
      if (!node) return;
      e.preventDefault();
      e.stopPropagation(); // block d3-zoom panning

      const div = card.parentNode;            // .node-foreign-object-div
      const fo = div && div.parentNode;        // <foreignObject>
      const g = fo && fo.parentNode;           // node <g>
      let k = 1;
      try { k = chart.getChartState().lastTransform.k || 1; } catch (_) {}

      drag = {
        node, card, div, fo,
        rect: g && g.querySelector(".node-rect"),
        x: e.clientX, y: e.clientY, w: node.width || NODE_WIDTH, h: node.height, k,
      };
      document.body.classList.add("resizing");
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    }, true);

    function onMove(e) {
      if (!drag) return;
      const w = Math.max(220, Math.min(1000, drag.w + (e.clientX - drag.x) / drag.k));
      const h = Math.max(90,  Math.min(1400, drag.h + (e.clientY - drag.y) / drag.k));
      drag.node.width = w;
      drag.node.height = h;
      // live feedback without a full relayout
      drag.card.style.width = w + "px";
      drag.card.style.height = h + "px";
      if (drag.div) { drag.div.style.width = w + "px"; drag.div.style.height = h + "px"; }
      if (drag.fo)  { drag.fo.setAttribute("width", w); drag.fo.setAttribute("height", h); }
      if (drag.rect) { drag.rect.setAttribute("width", w); drag.rect.setAttribute("height", h); }
    }

    function onUp() {
      if (!drag) return;
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      document.body.classList.remove("resizing");
      drag = null;
      safe(() => chart.render()); // relayout siblings so nothing overlaps + redraw links
    }
  }

  // ---- controls ---------------------------------------------------------
  function safe(fn) { try { fn(); } catch (e) { console.warn(e); } }

  function expandAll()   { safe(() => chart.expandAll().render().fit()); }
  function collapseAll() {
    safe(() => {
      chart.collapseAll();
      // keep the document root + its direct children visible
      chart.data().forEach((d) => { if (d.depth <= 1) d._expanded = true; });
      chart.render().fit();
    });
  }
  function fit()     { safe(() => chart.fit()); }
  function zoomIn()  { safe(() => chart.zoomIn()); }
  function zoomOut() { safe(() => chart.zoomOut()); }

  function setLayout(val) {
    curLayout = val;
    safe(() => chart.layout(val).render().fit());
  }
  function toggleCompact(btn) {
    isCompact = !isCompact;
    btn.classList.toggle("active", isCompact);
    safe(() => chart.compact(isCompact).render().fit());
  }
  function exportPng() {
    safe(() => chart.exportImg({ full: true, scale: 2 }));
    toast("Exporting PNG…");
  }

  function search(q) {
    if (currentMode === "reader") return searchDocument(q);
    q = (q || "").trim().toLowerCase();
    safe(() => chart.clearHighlighting());
    document.querySelectorAll(".md-node.matched").forEach((el) => el.classList.remove("matched"));
    if (!q) return;
    const m = nodes.find(
      (n) => (n.titleRaw || "").toLowerCase().includes(q) ||
             (n.raw || "").toLowerCase().includes(q)
    );
    if (!m) { toast("No match"); return; }
    safe(() => {
      chart.setUpToTheRootHighlighted(m.id).setCentered(m.id).render();
      // flash the matched card once it's in the DOM
      setTimeout(() => {
        const el = document.querySelector(`.md-node[data-id="${m.id}"]`);
        if (el) el.classList.add("matched");
      }, 120);
    });
  }

  // Reader-mode search: scroll to and flash the first block containing q.
  function searchDocument(q) {
    const host = $("#doc-content");
    if (!host) return;
    host.querySelectorAll(".doc-flash").forEach((el) => el.classList.remove("doc-flash"));
    q = (q || "").trim().toLowerCase();
    if (!q) return;
    const blocks = host.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,pre");
    let hit = null;
    for (const el of blocks) {
      if ((el.textContent || "").toLowerCase().includes(q)) { hit = el; break; }
    }
    if (!hit) { toast("No match"); return; }
    hit.scrollIntoView({ behavior: "smooth", block: "center" });
    hit.classList.add("doc-flash");
  }

  // ---- file loading -----------------------------------------------------
  function loadText(text, name) {
    currentMd = text;
    currentTitle = (name || "Document").replace(/\.(md|markdown|txt)$/i, "");
    parsedList = parseMarkdown(text, currentTitle);
    chartBuilt = false;
    $("#empty").style.display = "none";
    $("#doc-name").textContent = name || "Document";
    renderActiveView();
    toast(`Loaded · ${parsedList.length} section${parsedList.length === 1 ? "" : "s"}`);
  }

  // Render whichever view is active. The org-chart is built lazily — and only
  // while its container is visible — so d3's fit() always sees real dimensions.
  function renderActiveView() {
    if (currentMode === "reader") {
      renderDocument();
    } else if (!chartBuilt && parsedList) {
      renderChart(parsedList);
      chartBuilt = true;
    }
  }

  // Reader mode: render the entire file as one continuously-scrolling document.
  function renderDocument() {
    const host = $("#doc-content");
    if (!host) return;
    host.innerHTML = (currentMd && currentMd.trim())
      ? wrapTables(sanitize(marked.parse(currentMd)))
      : '<p class="doc-empty">This document is empty.</p>';
    const scroller = $("#document");
    if (scroller) scroller.scrollTop = 0;
  }

  // Switch between mindmap (org-chart) and reader (full document) views.
  function setMode(mode) {
    if (mode !== "reader" && mode !== "mindmap") return;
    currentMode = mode;
    document.body.classList.toggle("mode-reader", mode === "reader");
    document.body.classList.toggle("mode-mindmap", mode === "mindmap");
    updateModeButtons();
    try { localStorage.setItem("mdreader.mode", mode); } catch (_) {}
    renderActiveView();
    // Re-fit once the chart's container is visible again.
    if (mode === "mindmap" && chartBuilt) safe(() => chart.fit());
  }

  function updateModeButtons() {
    document.querySelectorAll("#mode-toggle .seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === currentMode));
  }

  function loadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => loadText(String(e.target.result), file.name);
    reader.readAsText(file);
  }

  // ---- paste-markdown modal --------------------------------------------
  function openPasteModal() {
    const m = $("#paste-modal");
    if (!m) return;
    m.classList.add("show");
    const nameEl = $("#paste-name");
    if (nameEl && !nameEl.value) nameEl.value = "Pasted.md";
    // focus the textarea so Ctrl+V works immediately
    setTimeout(() => { const t = $("#paste-text"); if (t) t.focus(); }, 0);
  }

  function closePasteModal() {
    const m = $("#paste-modal");
    if (m) m.classList.remove("show");
  }

  function loadPasted() {
    const text = ($("#paste-text") && $("#paste-text").value) || "";
    if (!text.trim()) { toast("Nothing to load"); return; }
    let name = (($("#paste-name") && $("#paste-name").value) || "").trim() || "Pasted.md";
    if (!/\.(md|markdown|txt)$/i.test(name)) name += ".md";
    closePasteModal();
    loadText(text, name);
  }

  // ---- toast ------------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    let el = $("#toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
  }

  // ---- wire up UI -------------------------------------------------------
  function init() {
    $("#btn-open").addEventListener("click", () => $("#file-input").click());
    $("#file-input").addEventListener("change", (e) => loadFile(e.target.files[0]));
    $("#btn-sample").addEventListener("click", () => loadText(SAMPLE_MD, "Welcome.md"));

    $("#btn-expand").addEventListener("click", expandAll);
    $("#btn-collapse").addEventListener("click", collapseAll);
    $("#btn-fit").addEventListener("click", fit);
    $("#btn-zoom-in").addEventListener("click", zoomIn);
    $("#btn-zoom-out").addEventListener("click", zoomOut);
    $("#btn-export").addEventListener("click", exportPng);
    $("#layout").addEventListener("change", (e) => setLayout(e.target.value));
    $("#btn-compact").addEventListener("click", (e) => toggleCompact(e.currentTarget));
    $("#btn-theme").addEventListener("click", () => {
      document.body.classList.toggle("dark");
      $("#btn-theme").classList.toggle("active", document.body.classList.contains("dark"));
    });

    document.querySelectorAll("#mode-toggle .seg-btn").forEach((b) =>
      b.addEventListener("click", () => setMode(b.dataset.mode)));

    // paste-markdown modal wiring
    $("#btn-paste").addEventListener("click", openPasteModal);
    $("#paste-close").addEventListener("click", closePasteModal);
    $("#paste-cancel").addEventListener("click", closePasteModal);
    $("#paste-load").addEventListener("click", loadPasted);
    $("#paste-modal").addEventListener("click", (e) => {
      // click outside the card dismisses
      if (e.target === $("#paste-modal")) closePasteModal();
    });
    $("#paste-text").addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); loadPasted(); }
    });

    const searchInput = $("#search");
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") search(searchInput.value); });
    searchInput.addEventListener("input", (e) => { if (!e.target.value) search(""); });

    // keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      // Escape always closes the paste modal (even when focus is in the textarea).
      if (e.key === "Escape" && $("#paste-modal").classList.contains("show")) {
        e.preventDefault(); closePasteModal(); return;
      }
      // Suppress single-key shortcuts while typing in a field or while the modal is open.
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      if ($("#paste-modal").classList.contains("show")) return;
      if (e.key === "o") { e.preventDefault(); $("#file-input").click(); }
      else if (e.key === "p") { e.preventDefault(); openPasteModal(); }
      else if (e.key === "f") { e.preventDefault(); fit(); }
      else if (e.key === "e") { expandAll(); }
      else if (e.key === "c") { collapseAll(); }
      else if (e.key === "/") { e.preventDefault(); searchInput.focus(); }
      else if (e.key === "+" || e.key === "=") { zoomIn(); }
      else if (e.key === "-") { zoomOut(); }
      else if (e.key === "v") { setMode(currentMode === "reader" ? "mindmap" : "reader"); }
    });

    // node resizing (delegated; survives chart re-renders)
    setupResize();

    // drag & drop anywhere
    const overlay = $("#drop-overlay");
    let dragDepth = 0;
    window.addEventListener("dragenter", (e) => { e.preventDefault(); if (++dragDepth) overlay.classList.add("show"); });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove("show"); } });
    window.addEventListener("drop", (e) => {
      e.preventDefault(); dragDepth = 0; overlay.classList.remove("show");
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    // restore the last-used view mode (default: mindmap) before first render
    try {
      const saved = localStorage.getItem("mdreader.mode");
      if (saved === "reader" || saved === "mindmap") currentMode = saved;
    } catch (_) {}
    document.body.classList.add(currentMode === "reader" ? "mode-reader" : "mode-mindmap");
    updateModeButtons();

    // load the welcome doc so the canvas is never empty
    loadText(SAMPLE_MD, "Welcome.md");
  }

  // ---- built-in sample (also demonstrates the scroll-box behavior) ------
  const SAMPLE_MD = [
    "# Markdown Org Reader",
    "Drop any **`.md`** file onto this window — or press **`o`** to open one. Each heading becomes a card; the section's content lives inside it. This intro is deliberately long so you can watch it **wrap and scroll vertically** inside a fixed-width box instead of stretching the page sideways. Resize, zoom, pan — the box never grows horizontally.",
    "",
    "## How it works",
    "The file's heading levels (`#`, `##`, `###` …) form the tree. A section's body is everything beneath its heading up to the next one — rendered as real markdown.",
    "",
    "### Long text stays boxed",
    "No matter how much prose a section contains, it is clamped to a maximum height and gains a vertical scrollbar. Horizontal overflow is disabled and long unbroken strings break instead of stretching — e.g. https://this-is-an-intentionally-very-long-url.example.com/that/would/otherwise/blow/out/the/layout?with=many&query=params&and=more&stuff=here wraps cleanly.",
    "",
    "### Tables scroll inside the box",
    "Wide tables get their *own* contained horizontal scrollbar — the card itself stays fixed-width:",
    "",
    "| Platform | Strength | Notes for a wide column that keeps going |",
    "|---|---|---|",
    "| MetaTrader 4/5 | Ubiquitous | Legacy tooling, huge ecosystem, lots of EAs |",
    "| MatchTrader | Modern | Popular with prop firms, cleaner API surface |",
    "| TradeLocker | Web-first | Growing fast in the prop-firm era |",
    "",
    "### Code wraps too",
    "```js",
    "const chart = new d3.OrgChart().container('#chart').data(nodes).render();",
    "// even a very long single line of code like this one will soft-wrap rather than forcing the whole card to scroll sideways forever and ever",
    "```",
    "",
    "## Controls",
    "- **Mindmap ↔ Reader** toggle (top toolbar): *Mindmap* shows the outline as cards; *Reader* shows the whole file as one scrollable document.",
    "- **Expand / Collapse all**, **Fit**, **zoom** buttons in the toolbar (mindmap mode)",
    "- **Search** (`/`) centers the first matching section — in Reader mode it scrolls to the first match",
    "- **Layout** switch (top-down ↔ left-right), **Compact** toggle, **dark mode**",
    "- Shortcuts: `o` open · `p` paste · `v` toggle view · `f` fit · `e` expand · `c` collapse · `+` / `-` zoom",
    "",
    "### Try it now",
    "Open your own **`FINDINGS.md`** to see a real, deeply-nested document render instantly.",
  ].join("\n");

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
