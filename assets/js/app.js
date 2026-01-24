// Retraction Radar 2.0
// Frontend version inspired by Apps Script code.gs
// - Uses OpenAlex + Retraction Watch CSV
// - For a single DOI:
//     1) Shows main article details + retraction flag
//     2) Evaluates all references,
//     3) Renders only:
//          a) Retracted references
//          b) Problematic references (no DOI, unknown / fetch errors)
//     4) Each rendered reference has a detailed citation built from OpenAlex

// -------------------- Config --------------------

const OPENALEX_MAILTO = "name@example.org"; // optional; put your email if you want

// Live Retraction Watch CSV (Crossref / RW dataset)
const RW_CSV_URL =
  "https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv?ref_type=heads";

// OpenAlex batch size (how many referenced works per request)
const OPENALEX_REF_BATCH_SIZE = 40;

// -------------------- Global state --------------------

let lastAnalyzedDoi = "";
let currentInterestingRefs = []; // only retracted + problematic
let currentCounts = null;        // summary counts for info & pills
let rwIndexPromise = null;       // Promise<Set<string>> of normalized DOIs from RW CSV

// -------------------- Small helpers --------------------

function $(id) {
  return document.getElementById(id);
}

function setStatus(message, isError = false) {
  const el = $("status");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("error", !!isError);
}

function statusTag(label, extraClass) {
  const cls = ["status-tag"];
  if (extraClass) cls.push(extraClass);
  return `<span class="${cls.join(" ")}">${label}</span>`;
}

function mapStatusToTag(status) {
  switch (status) {
    case "retracted":
      return statusTag("RETRACTED", "status-tag--retracted");
    case "problem_no_doi":
      return statusTag("NO DOI", "status-tag--no-doi");
    case "problem_unknown":
      return statusTag("UNKNOWN", "status-tag--unknown");
    default:
      return statusTag(status.toUpperCase(), "status-tag--clean");
  }
}

function normalizeDoi(raw) {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .toLowerCase();
}

// For severity / sorting: retracted first, then other problems
const STATUS_SCORE = {
  retracted: 3,
  problem_no_doi: 2,
  problem_unknown: 1,
  ok: 0,
};

function compareBySeverity(a, b) {
  const sa = STATUS_SCORE[a.status] ?? 0;
  const sb = STATUS_SCORE[b.status] ?? 0;
  if (sa !== sb) return sb - sa; // higher first
  return a.idx - b.idx;          // then by reference index
}

// -------------------- Retraction Watch CSV --------------------

// CSV parser that respects quotes + commas in quoted fields
function parseCsvLine(line) {
  const cols = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      cols.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cols.push(cur);
  return cols;
}

function parseRetractionWatchCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return new Set();

  const header = parseCsvLine(lines[0]);
  // In the Apps Script version we used OriginalPaperDOI; here we are more forgiving:
  const doiColIndex = header.findIndex((h) => {
    const t = h.trim().toLowerCase();
    return t === "originalpaperdoi" || t === "doi" || t.includes("doi");
  });

  if (doiColIndex === -1) {
    console.warn("Retraction Watch CSV: DOI column not found");
    return new Set();
  }

  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (doiColIndex >= cols.length) continue;
    const rawDoi = cols[doiColIndex];
    if (!rawDoi) continue;
    const norm = normalizeDoi(rawDoi);
    if (norm) seen.add(norm);
  }
  return seen;
}

function ensureRetractionWatchIndex() {
  if (!rwIndexPromise) {
    rwIndexPromise = fetch(RW_CSV_URL)
      .then((res) => {
        if (!res.ok) {
          throw new Error("Retraction Watch CSV HTTP " + res.status);
        }
        return res.text();
      })
      .then((text) => {
        console.log("Retraction Watch CSV loaded");
        return parseRetractionWatchCsv(text);
      })
      .catch((err) => {
        console.error("Retraction Watch CSV error:", err);
        // fail soft: empty set => "no matches"
        return new Set();
      });
  }
  return rwIndexPromise;
}

async function isDoiInRetractionWatch(doi) {
  const index = await ensureRetractionWatchIndex();
  if (!index.size) return false;
  const key = normalizeDoi(doi);
  return index.has(key);
}

// -------------------- OpenAlex helpers --------------------

async function fetchOpenAlexWorkByDoi(doi) {
  const normalized = normalizeDoi(doi) || doi.trim();
  let url =
    "https://api.openalex.org/works/https://doi.org/" +
    encodeURIComponent(normalized);

  if (OPENALEX_MAILTO) {
    url += "?mailto=" + encodeURIComponent(OPENALEX_MAILTO);
  }

  const res = await fetch(url);
  if (res.status === 404) {
    throw new Error("OpenAlex: DOI not found");
  }
  if (!res.ok) {
    throw new Error("OpenAlex work HTTP " + res.status);
  }
  return res.json();
}

async function fetchOpenAlexRefsBatch(openAlexIds) {
  if (!openAlexIds.length) return [];
  // extract WIDs
  const widList = openAlexIds
    .map((id) => {
      if (!id) return null;
      const parts = String(id).split("/");
      return parts[parts.length - 1];
    })
    .filter(Boolean);

  if (!widList.length) return [];

  let url =
    "https://api.openalex.org/works?filter=openalex:" +
    encodeURIComponent(widList.join("|")) +
    "&per-page=200&select=id,doi,is_retracted,display_name,publication_year,host_venue,authorships,biblio";

  if (OPENALEX_MAILTO) {
    url += "&mailto=" + encodeURIComponent(OPENALEX_MAILTO);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("OpenAlex refs HTTP " + res.status);
  }

  const json = await res.json();
  if (!json || !Array.isArray(json.results)) return [];
  return json.results;
}

function buildCitationFromOpenAlex(work) {
  if (!work) return "";

  const title = work.display_name || "";
  const year = work.publication_year || "";
  const venue = (work.host_venue && work.host_venue.display_name) || "";
  const biblio = work.biblio || {};
  const vol = biblio.volume || "";
  const issue = biblio.issue || "";
  const firstPage = biblio.first_page || "";
  const lastPage = biblio.last_page || "";
  const doi = work.doi || "";

  // authors: first 3
  let authors = "";
  if (Array.isArray(work.authorships) && work.authorships.length > 0) {
    const names = work.authorships
      .map((a) =>
        a.author && a.author.display_name ? a.author.display_name : ""
      )
      .filter((n) => n);
    if (names.length > 3) {
      authors = names.slice(0, 3).join(", ") + " et al.";
    } else {
      authors = names.join(", ");
    }
  }

  const parts = [];
  if (authors) parts.push(authors + ".");
  if (title) parts.push(title + ".");
  if (venue) parts.push(venue);
  const yearBits = [];
  if (year) yearBits.push(year);
  if (vol) yearBits.push(vol + (issue ? "(" + issue + ")" : ""));
  if (firstPage || lastPage) {
    let pages = firstPage || "";
    if (lastPage) pages += "-" + lastPage;
    yearBits.push("p. " + pages);
  }
  if (yearBits.length) parts.push(yearBits.join("; "));
  if (doi) parts.push("DOI: " + normalizeDoi(doi));

  return parts.join(" ");
}

// -------------------- Core logic --------------------

// Decide status for a single referenced work given OpenAlex + Retraction Watch
async function classifyReference(work, rwIndex) {
  const idx = work.__idx; // we will assign this manually
  const refDoi = work.doi || null;
  const isRetractedOpenAlex = !!work.is_retracted;

  let status = "ok";
  const notes = [];
  let viaRW = false;
  let viaOA = false;

  if (isRetractedOpenAlex) {
    status = "retracted";
    viaOA = true;
    notes.push("OpenAlex: is_retracted = true.");
  }

  if (refDoi && rwIndex && rwIndex.size) {
    const norm = normalizeDoi(refDoi);
    if (rwIndex.has(norm)) {
      status = "retracted";
      viaRW = true;
      notes.push("Retraction Watch CSV: DOI present.");
    }
  }

  if (!refDoi) {
    // Only mark as "problem_no_doi" if we *don't* already know it's retracted
    if (status === "ok") {
      status = "problem_no_doi";
      notes.push("No DOI available; cannot consult DOI-based indexes.");
    }
  }

  const citation = buildCitationFromOpenAlex(work);

  return {
    idx,
    title: work.display_name || "",
    year: work.publication_year || "",
    doi: refDoi,
    openAlexId: work.id || "",
    status,
    viaRW,
    viaOA,
    notes: notes.join(" "),
    citation,
  };
}

// classify an "error / missing" reference (OpenAlex error)
function classifyReferenceError(idx, openAlexId, errorMessage) {
  const shortId = (openAlexId || "").replace("https://openalex.org/", "");
  return {
    idx,
    title: `Reference unavailable in OpenAlex (ID: ${shortId})`,
    year: "",
    doi: null,
    openAlexId,
    status: "problem_unknown",
    viaRW: false,
    viaOA: false,
    notes:
      "Error fetching OpenAlex work for this reference: " +
      (errorMessage || "unknown error"),
    citation: "",
  };
}

// -------------------- Main analyze flow --------------------

async function analyzeDoi(rawInput) {
  const doi = normalizeDoi(rawInput);
  lastAnalyzedDoi = doi || rawInput.trim();

  const resultsBody = $("resultsBody");
  const exportBtn = $("exportCsvBtn");
  const summaryWrapper = $("summaryWrapper");
  const metaInfo = $("metaInfo");
  const metaStatusEl = $("metaStatus");

  currentInterestingRefs = [];
  currentCounts = null;

  // Reset UI
  resultsBody.innerHTML = "";
  summaryWrapper.classList.add("hidden");
  metaInfo.classList.add("hidden");
  if (metaStatusEl) metaStatusEl.innerHTML = "";
  exportBtn.disabled = true;

  if (!doi) {
    setStatus("Please enter a DOI.", true);
    return;
  }

  setStatus("Resolving DOI via OpenAlex…");

  const rwIndex = await ensureRetractionWatchIndex(); // load in parallel early

  // 1) Main article
  const work = await fetchOpenAlexWorkByDoi(doi);
  const title = work.display_name || "(no title)";
  const year = work.publication_year || "";
  const workDoi = work.doi || doi;
  const refIds = work.referenced_works || [];

  $("metaTitle").textContent = title;
  $("metaYear").textContent = year || "–";
  $("metaDoi").textContent = workDoi || "–";
  $("metaRefCount").textContent = refIds.length;
  metaInfo.classList.remove("hidden");

  // Main article retraction status (OpenAlex + Retraction Watch)
  const mainNormDoi = normalizeDoi(workDoi);
  let mainRetractedOA = !!work.is_retracted;
  let mainRetractedRW =
    mainNormDoi && rwIndex && rwIndex.size && rwIndex.has(mainNormDoi);

  let mainStatusHtml = "";
  if (mainRetractedOA || mainRetractedRW) {
    mainStatusHtml = statusTag("THIS ARTICLE IS RETRACTED", "status-tag--retracted");
  } else {
    mainStatusHtml = statusTag("Article not flagged as retracted", "status-tag--clean");
  }
  if (metaStatusEl) {
    metaStatusEl.innerHTML = mainStatusHtml;
  }

  if (!refIds.length) {
    setStatus("OpenAlex: this work lists 0 references.");
    return;
  }

  setStatus(
    `Found ${refIds.length} referenced works. Checking retractions via OpenAlex + Retraction Watch…`
  );

  // 2) References
  const allRefs = [];
  let idxCounter = 0;

  for (let start = 0; start < refIds.length; start += OPENALEX_REF_BATCH_SIZE) {
    const slice = refIds.slice(start, start + OPENALEX_REF_BATCH_SIZE);
    let batchWorks = [];
    try {
      batchWorks = await fetchOpenAlexRefsBatch(slice);
    } catch (err) {
      console.error("Error fetching refs batch:", err);
      // if the batch fails completely, mark each as problematic
      slice.forEach((id) => {
        idxCounter++;
        allRefs.push(
          classifyReferenceError(idxCounter, id, err.message || "batch error")
        );
      });
      continue;
    }

    // map from ID → work for quick lookup
    const mapById = new Map();
    batchWorks.forEach((w) => {
      if (w && w.id) {
        mapById.set(w.id, w);
      }
    });

    // keep original order matching refIds
    for (const refId of slice) {
      idxCounter++;
      const w = mapById.get(refId);
      if (!w) {
        allRefs.push(
          classifyReferenceError(
            idxCounter,
            refId,
            "not returned in OpenAlex results"
          )
        );
      } else {
        w.__idx = idxCounter; // assign index
        const refObj = await classifyReference(w, rwIndex);
        allRefs.push(refObj);
      }
    }

    if (idxCounter % 20 === 0) {
      setStatus(
        `Checked ${idxCounter}/${refIds.length} references… still working.`
      );
    }
  }

  // 3) Compute counts and filter interesting refs
  const counts = {
    total: allRefs.length,
    retracted: 0,
    problem_no_doi: 0,
    problem_unknown: 0,
    ok: 0,
  };

  allRefs.forEach((r) => {
    if (r.status in counts) {
      counts[r.status]++;
    } else {
      counts.ok++;
    }
  });

  const interesting = allRefs.filter(
    (r) => r.status !== "ok"
  );
  interesting.sort(compareBySeverity);

  currentInterestingRefs = interesting;
  currentCounts = counts;

  // 4) Render table (only interesting refs)
  resultsBody.innerHTML = "";

  if (!interesting.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="6" style="padding:0.75rem;color:#9ca3af;">No retracted or problematic references detected. All references appear OK according to OpenAlex + Retraction Watch (but manual checking is still recommended).</td>';
    resultsBody.appendChild(tr);
  } else {
    interesting.forEach((ref) => appendRefRow(ref));
  }

  // 5) Render summary pills
  renderSummaryPills(counts);

  $("summaryWrapper").classList.remove("hidden");
  exportBtn.disabled = currentInterestingRefs.length === 0;

  if (counts.retracted > 0) {
    setStatus(
      `Finished. Found ${counts.retracted} retracted references and ${counts.problem_no_doi + counts.problem_unknown} problematic references among ${counts.total} total.`
    );
  } else {
    setStatus(
      `Finished. No retracted references detected via OpenAlex/Retraction Watch among ${counts.total} total. ${counts.problem_no_doi + counts.problem_unknown} references are problematic (no DOI / unknown).`
    );
  }
}

// -------------------- Rendering --------------------

function appendRefRow(ref) {
  const tbody = $("resultsBody");
  const tr = document.createElement("tr");
  tr.dataset.status = ref.status;

  // Link: DOI if present; otherwise OpenAlex ID
  let linkHtml = "—";
  if (ref.doi) {
    linkHtml = `<a href="https://doi.org/${encodeURIComponent(
      normalizeDoi(ref.doi)
    )}" target="_blank" rel="noopener noreferrer" class="doi-link">${normalizeDoi(
      ref.doi
    )}</a>`;
  } else if (ref.openAlexId) {
    const shortId = ref.openAlexId.replace("https://openalex.org/", "");
    linkHtml = `<a href="${ref.openAlexId}" target="_blank" rel="noopener noreferrer" class="doi-link">OpenAlex ${shortId}</a>`;
  }

  const titleText = ref.title || "(no title available)";
  const citationText = ref.citation || "";

  tr.innerHTML = `
    <td>${ref.idx}</td>
    <td>${mapStatusToTag(ref.status)}</td>
    <td>${ref.year || "—"}</td>
    <td>
      <div style="max-width: 360px; word-break: break-word;">
        <div>${titleText}</div>
        ${
          citationText
            ? `<div style="margin-top:0.25rem;font-size:0.78rem;color:#9ca3af;">${citationText}</div>`
            : ""
        }
      </div>
    </td>
    <td>${linkHtml}</td>
    <td>
      <div style="max-width: 320px; word-break: break-word; color:#9ca3af;">
        ${ref.notes || ""}
      </div>
    </td>
  `;

  tbody.appendChild(tr);
}

function renderSummaryPills(counts) {
  const summary = $("summary");
  summary.innerHTML = "";

  const pills = [];

  function makePill(label, value, subtle) {
    const btn = document.createElement("div");
    btn.className = "pill pill--static" + (subtle ? " pill--muted" : "");
    btn.innerHTML = `
      <span class="pill-label">${label}</span>
      <span class="pill-count">${value}</span>
    `;
    return btn;
  }

  pills.push(makePill("Total references", counts.total));
  pills.push(makePill("Retracted", counts.retracted || 0, counts.retracted === 0));
  pills.push(
    makePill(
      "Problematic (no DOI / unknown)",
      (counts.problem_no_doi || 0) + (counts.problem_unknown || 0),
      (counts.problem_no_doi || 0) + (counts.problem_unknown || 0) === 0
    )
  );
  pills.push(
    makePill(
      "OK (not listed below)",
      counts.total -
        counts.retracted -
        counts.problem_no_doi -
        counts.problem_unknown,
      true
    )
  );

  pills.forEach((p) => summary.appendChild(p));
}

// -------------------- CSV export --------------------

function exportCurrentToCsv() {
  if (!currentInterestingRefs || !currentInterestingRefs.length) return;

  const header = [
    "index",
    "status",
    "year",
    "title",
    "doi_or_openalex",
    "citation",
    "notes",
  ];
  const rows = [header];

  currentInterestingRefs.forEach((r) => {
    const linkField = r.doi
      ? normalizeDoi(r.doi)
      : r.openAlexId || "";
    rows.push([
      String(r.idx ?? ""),
      r.status ?? "",
      r.year != null ? String(r.year) : "",
      r.title ?? "",
      linkField,
      r.citation ?? "",
      r.notes ?? "",
    ]);
  });

  const csv = rows
    .map((cols) =>
      cols
        .map((val) => {
          const v = String(val ?? "").replace(/"/g, '""');
          return `"${v}"`;
        })
        .join(",")
    )
    .join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const baseName =
    (lastAnalyzedDoi || "results")
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 80) || "results";

  const a = document.createElement("a");
  a.href = url;
  a.download = `retraction-radar-${baseName}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// -------------------- Wiring --------------------

function setup() {
  const form = $("doiForm");
  const input = $("doiInput");
  const analyzeBtn = $("analyzeBtn");
  const exportBtn = $("exportCsvBtn");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const doi = input.value.trim();
    if (!doi) return;

    analyzeBtn.disabled = true;
    exportBtn.disabled = true;
    setStatus("");

    try {
      await analyzeDoi(doi);
    } catch (err) {
      console.error(err);
      setStatus("Error: " + err.message, true);
    } finally {
      analyzeBtn.disabled = false;
      exportBtn.disabled = !currentInterestingRefs.length;
    }
  });

  exportBtn.addEventListener("click", exportCurrentToCsv);
}

// Script is loaded at the end of <body>, so DOM is ready
setup();
