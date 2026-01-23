// assets/js/app.js
// Retraction Radar – OpenAlex + Crossref + PubMed + Retraction Watch CSV

// -------------------- Global state --------------------

let currentFilter = "all";
let currentStudies = [];        // all rows for current analysis
let lastAnalyzedDoi = "";       // used for CSV filename

// PubMed config
const PUBMED_API_KEY = "7d653c3573d4967a70f644df87ffbd392708";

// Retraction Watch CSV (live)
const RW_CSV_URL =
  "https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv?ref_type=heads";

// Promise<Set<string>> (normalized DOIs present in RW CSV)
let rwIndexPromise = null;

// severity ranking when combining all sources
const STATUS_SEVERITY = {
  retracted: 5,
  expression_of_concern: 4,
  withdrawn: 4,
  corrected: 3,
  ok: 2,
  no_doi: 1,
  unknown: 1,
};

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
    case "expression_of_concern":
      return statusTag("EXPRESSION OF CONCERN", "status-tag--eoc");
    case "corrected":
      return statusTag("CORRECTED / ERRATUM", "status-tag--clean");
    case "withdrawn":
      return statusTag("WITHDRAWN", "status-tag--eoc");
    case "no_doi":
      return statusTag("NO DOI", "status-tag--no-doi");
    case "unknown":
      return statusTag("UNKNOWN", "status-tag--unknown");
    case "ok":
    default:
      return statusTag("OK", "status-tag--clean");
  }
}

function normalizeDoiForLookup(doi) {
  if (!doi) return "";
  return doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .toLowerCase();
}

function pickMoreSevereStatus(aStatus, bStatus) {
  const a = STATUS_SEVERITY[aStatus] ?? 0;
  const b = STATUS_SEVERITY[bStatus] ?? 0;
  return a >= b ? aStatus : bStatus;
}

// -------------------- CSV parsing for Retraction Watch --------------------

// Simple CSV line parser that respects quotes and commas in quoted fields
function parseCsvLine(line) {
  const cols = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];

    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        cur += '"';
        i++; // skip next
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
  const doiColIndex = header.findIndex((h) =>
    h.trim().toLowerCase() === "doi" || h.toLowerCase().includes("doi")
  );
  if (doiColIndex === -1) {
    console.warn("Retraction Watch CSV: DOI column not found in header");
    return new Set();
  }

  const seen = new Set();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (doiColIndex >= cols.length) continue;
    let doi = cols[doiColIndex] || "";
    if (!doi) continue;

    const norm = normalizeDoiForLookup(doi);
    if (norm) seen.add(norm);
  }

  return seen;
}

function ensureRetractionWatchIndex() {
  if (!rwIndexPromise) {
    rwIndexPromise = fetch(RW_CSV_URL)
      .then((res) => {
        if (!res.ok) {
          throw new Error(
            "Retraction Watch CSV fetch failed: " + res.status
          );
        }
        return res.text();
      })
      .then((text) => {
        console.log("Retraction Watch CSV loaded");
        return parseRetractionWatchCsv(text);
      })
      .catch((err) => {
        console.error("Retraction Watch CSV error:", err);
        // Fail soft: empty set means "no match"
        return new Set();
      });
  }
  return rwIndexPromise;
}

async function getRetractionWatchInfoForDoi(doi) {
  const index = await ensureRetractionWatchIndex();
  const key = normalizeDoiForLookup(doi);

  if (!index.size) {
    return {
      status: "ok",
      notes: "Retraction Watch CSV could not be loaded or was empty.",
    };
  }

  if (index.has(key)) {
    // RW dataset is a retraction index; treat presence as "retracted" signal
    return {
      status: "retracted",
      notes:
        "Retraction Watch CSV: DOI present in retraction_watch.csv (Crossref/Retraction Watch dataset).",
    };
  }

  return {
    status: "ok",
    notes:
      "Retraction Watch CSV: DOI not found in retraction_watch.csv (at time of query).",
  };
}

// -------------------- OpenAlex --------------------

async function fetchOpenAlexWorkByDoi(doi) {
  const normalized = doi.trim();
  const url =
    "https://api.openalex.org/works/https://doi.org/" +
    encodeURIComponent(normalized);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OpenAlex error for DOI ${normalized}: ${res.status}`);
  }
  return res.json();
}

async function fetchOpenAlexWorkById(openAlexId) {
  const url = `https://api.openalex.org/works/${encodeURIComponent(
    openAlexId.replace("https://openalex.org/", "")
  )}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OpenAlex error for ID ${openAlexId}: ${res.status}`);
  }
  return res.json();
}

// -------------------- Crossref --------------------

async function fetchCrossrefForDoi(doi) {
  const url =
    "https://api.crossref.org/works/" + encodeURIComponent(doi.trim());
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Crossref error for DOI ${doi}: ${res.status}`);
  }
  const json = await res.json();
  return json.message || {};
}

function determineRetractionStatusFromCrossref(message) {
  let status = "ok";
  const notes = [];

  const updateTo = message["update-to"] || message["update_to"] || [];
  if (Array.isArray(updateTo) && updateTo.length > 0) {
    for (const u of updateTo) {
      const updateType = (u["update-type"] || u["update_type"] || "").toLowerCase();
      if (updateType.includes("retract")) {
        status = "retracted";
        notes.push("Crossref: update-type = retraction.");
      } else if (updateType.includes("expression")) {
        status = "expression_of_concern";
        notes.push("Crossref: update-type = expression of concern.");
      } else if (
        updateType.includes("correction") ||
        updateType.includes("erratum")
      ) {
        if (status === "ok") status = "corrected";
        notes.push("Crossref: update-type = correction/erratum.");
      } else if (updateType.includes("withdraw")) {
        if (status === "ok") status = "withdrawn";
        notes.push("Crossref: update-type = withdrawal.");
      }
    }
  }

  if (message.relation) {
    const rel = message.relation;
    if (rel["is-retracted-by"] || rel["is-retracted-by:"]) {
      status = "retracted";
      notes.push("Crossref relation: is-retracted-by.");
    } else if (rel["has-retraction"] || rel["has-retraction:"]) {
      status = "retracted";
      notes.push("Crossref relation: has-retraction.");
    }
  }

  if (status === "ok" && notes.length === 0) {
    notes.push("Crossref: no retraction/correction signals found.");
  }

  return {
    status,
    notes: notes.join(" "),
  };
}

async function getCrossrefRetractionInfoForDoi(doi) {
  try {
    const message = await fetchCrossrefForDoi(doi);
    return determineRetractionStatusFromCrossref(message);
  } catch (err) {
    console.error("Error checking Crossref", doi, err);
    return {
      status: "unknown",
      notes: "Crossref error: " + err.message,
    };
  }
}

// -------------------- PubMed via NCBI E-utilities --------------------

// 1) find PubMed ID (PMID) from DOI
async function fetchPubMedIdForDoi(doi) {
  const term = `${doi.trim()}[DOI]`;
  const url =
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" +
    `?db=pubmed&retmode=json&term=${encodeURIComponent(term)}` +
    `&api_key=${encodeURIComponent(PUBMED_API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`PubMed esearch error for DOI ${doi}: ${res.status}`);
  }
  const json = await res.json();
  const ids = (json.esearchresult && json.esearchresult.idlist) || [];
  if (!ids.length) return null;
  return ids[0]; // first PMID
}

// 2) get summary for that PMID and inspect publication types
async function fetchPubMedSummaryForPmid(pmid) {
  const url =
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi" +
    `?db=pubmed&retmode=json&id=${encodeURIComponent(pmid)}` +
    `&api_key=${encodeURIComponent(PUBMED_API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`PubMed esummary error for PMID ${pmid}: ${res.status}`);
  }
  const json = await res.json();
  if (!json.result || !json.result[pmid]) {
    throw new Error(`PubMed esummary: missing result for PMID ${pmid}`);
  }
  return json.result[pmid];
}

function determineRetractionStatusFromPubMedSummary(pmid, summary) {
  const pubtypes = summary.pubtype || [];
  const pubtypesLower = pubtypes.map((p) => String(p).toLowerCase());
  let status = "ok";
  const notes = [];

  for (const pt of pubtypesLower) {
    if (pt.includes("retracted publication")) {
      status = "retracted";
      notes.push("PubMed: publication type = Retracted Publication.");
      break;
    }
    if (pt.includes("retraction of publication")) {
      status = "retracted";
      notes.push("PubMed: publication type = Retraction of Publication (notice).");
      break;
    }
    if (pt.includes("expression of concern")) {
      status = "expression_of_concern";
      notes.push("PubMed: publication type = Expression of Concern.");
      break;
    }
    if (
      pt.includes("erratum") ||
      pt.includes("corrigendum") ||
      pt.includes("correction")
    ) {
      if (status === "ok") {
        status = "corrected";
      }
      notes.push("PubMed: publication type indicates correction/erratum.");
    }
  }

  if (status === "ok" && notes.length === 0) {
    notes.push("PubMed: no retraction-related publication types.");
  }

  return {
    status,
    notes: notes.join(" "),
    pmid,
  };
}

async function getPubMedRetractionInfoForDoi(doi) {
  try {
    const pmid = await fetchPubMedIdForDoi(doi);
    if (!pmid) {
      return {
        status: "ok",
        notes: "PubMed: no record found for this DOI.",
        pmid: null,
      };
    }
    const summary = await fetchPubMedSummaryForPmid(pmid);
    return determineRetractionStatusFromPubMedSummary(pmid, summary);
  } catch (err) {
    console.error("Error checking PubMed", doi, err);
    return {
      status: "unknown",
      notes: "PubMed error: " + err.message,
      pmid: null,
    };
  }
}

// -------------------- Combine all sources --------------------

async function getCombinedRetractionInfoForDoi(doi) {
  const [crossrefInfo, pubmedInfo, rwInfo] = await Promise.all([
    getCrossrefRetractionInfoForDoi(doi),
    getPubMedRetractionInfoForDoi(doi),
    getRetractionWatchInfoForDoi(doi),
  ]);

  const combinedStatus = pickMoreSevereStatus(
    pickMoreSevereStatus(crossrefInfo.status, pubmedInfo.status),
    rwInfo.status
  );

  const combinedNotes = [
    crossrefInfo.notes,
    pubmedInfo.notes,
    rwInfo.notes,
    pubmedInfo.pmid ? `PubMed PMID: ${pubmedInfo.pmid}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    status: combinedStatus,
    notes: combinedNotes,
  };
}

// -------------------- Core workflow --------------------

function normalizeDoiInput(raw) {
  if (!raw) return "";
  const trimmed = raw.trim();

  // Extract DOI from URL if needed
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const parts = trimmed.split("doi.org/");
    if (parts.length > 1) return parts[1].trim();
  }

  // If there's a 10.xxxx pattern inside, use from there
  const idx = trimmed.indexOf("10.");
  if (idx >= 0) return trimmed.slice(idx);

  return trimmed;
}

async function analyzeDoi(doiRaw) {
  const doi = normalizeDoiInput(doiRaw);
  lastAnalyzedDoi = doi || doiRaw.trim();

  const resultsBody = $("resultsBody");
  const exportBtn = $("exportCsvBtn");
  currentStudies = [];
  currentFilter = "all";

  // Reset UI
  resultsBody.innerHTML = "";
  $("metaInfo").classList.add("hidden");
  $("summaryWrapper").classList.add("hidden");
  exportBtn.disabled = true;

  setStatus("Resolving DOI via OpenAlex…");

  const work = await fetchOpenAlexWorkByDoi(doi || doiRaw.trim());

  const title = work.display_name || "(no title)";
  const year = work.publication_year || "";
  const workDoi = work.doi || (doi || doiRaw.trim());
  const referenced = work.referenced_works || [];

  $("metaTitle").textContent = title;
  $("metaYear").textContent = year || "–";
  $("metaDoi").textContent = workDoi || "–";
  $("metaRefCount").textContent = referenced.length;
  $("metaInfo").classList.remove("hidden");

  if (!referenced.length) {
    setStatus("This work has no referenced_works in OpenAlex. Nothing to check.");
    return;
  }

  setStatus(
    `Found ${referenced.length} referenced works in OpenAlex. Fetching metadata and retraction status (Crossref + PubMed + Retraction Watch)…`
  );

  const maxRefs = 200;
  const truncated = referenced.slice(0, maxRefs);

  let index = 0;
  for (const refId of truncated) {
    index += 1;

    try {
      const refWork = await fetchOpenAlexWorkById(refId);

      const refTitle = refWork.display_name || "(no title)";
      const refYear = refWork.publication_year || "";
      const refDoi = refWork.doi || null;

      let retractionStatus = { status: "no_doi", notes: "No DOI available." };

      if (refDoi) {
        retractionStatus = await getCombinedRetractionInfoForDoi(refDoi);
      }

      const study = {
        idx: index,
        title: refTitle,
        year: refYear,
        doi: refDoi,
        status: retractionStatus.status,
        notes: retractionStatus.notes,
      };

      currentStudies.push(study);
      appendStudyRow(study);

      if (index % 10 === 0) {
        setStatus(
          `Checked ${index}/${truncated.length} references… still working (Crossref + PubMed + Retraction Watch).`
        );
      }
    } catch (err) {
      console.error("Error processing reference", refId, err);
      const study = {
        idx: index,
        title: "(error fetching reference)",
        year: "",
        doi: null,
        status: "unknown",
        notes: "Error fetching OpenAlex work for this reference.",
      };
      currentStudies.push(study);
      appendStudyRow(study);
    }
  }

  const counts = {
    total: currentStudies.length,
    ok: 0,
    retracted: 0,
    expression_of_concern: 0,
    corrected: 0,
    withdrawn: 0,
    no_doi: 0,
    unknown: 0,
  };

  for (const s of currentStudies) {
    if (counts[s.status] !== undefined) {
      counts[s.status] += 1;
    } else {
      counts.unknown += 1;
    }
  }

  renderSummary(counts);
  $("summaryWrapper").classList.remove("hidden");
  exportBtn.disabled = currentStudies.length === 0;

  if (counts.retracted > 0 || counts.expression_of_concern > 0) {
    setStatus(
      `Finished. Found ${counts.retracted} retracted and ${counts.expression_of_concern} with expression of concern among ${counts.total} cited works (Crossref + PubMed + Retraction Watch).`
    );
  } else {
    setStatus(
      `Finished. No retracted or EoC signals detected via Crossref/PubMed/Retraction Watch among ${counts.total} cited works. Always double-check manually.`
    );
  }
}

function appendStudyRow(study) {
  const tbody = $("resultsBody");
  const tr = document.createElement("tr");
  tr.dataset.status = study.status;

  const doiLink = study.doi
    ? `<a href="https://doi.org/${encodeURIComponent(
        study.doi
      )}" target="_blank" rel="noopener noreferrer" class="doi-link">${study.doi}</a>`
    : "—";

  tr.innerHTML = `
    <td>${study.idx}</td>
    <td>${mapStatusToTag(study.status)}</td>
    <td>${study.year || "—"}</td>
    <td><div style="max-width: 320px; word-break: break-word;">${study.title}</div></td>
    <td>${doiLink}</td>
    <td><div style="max-width: 320px; word-break: break-word; color:#9ca3af;">${study.notes}</div></td>
  `;

  tbody.appendChild(tr);
}

// -------------------- Summary + filter --------------------

function renderSummary(counts) {
  const summary = $("summary");
  summary.innerHTML = "";
  const pills = [];

  pills.push(makePill("all", "Total", counts.total));

  if (counts.retracted > 0)
    pills.push(makePill("retracted", "Retracted", counts.retracted));
  if (counts.expression_of_concern > 0)
    pills.push(
      makePill(
        "expression_of_concern",
        "Expression of concern",
        counts.expression_of_concern
      )
    );
  if (counts.corrected > 0)
    pills.push(makePill("corrected", "Corrected / Erratum", counts.corrected));
  if (counts.withdrawn > 0)
    pills.push(makePill("withdrawn", "Withdrawn", counts.withdrawn));
  if (counts.no_doi > 0)
    pills.push(makePill("no_doi", "No DOI", counts.no_doi));
  if (counts.unknown > 0)
    pills.push(makePill("unknown", "Unknown", counts.unknown));

  pills.forEach((btn) => summary.appendChild(btn));
  updatePillActiveStates();
}

function makePill(filter, label, count) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pill";
  btn.dataset.filter = filter;
  btn.innerHTML = `<span class="pill-label">${label}</span><span class="pill-count">${count}</span>`;

  btn.addEventListener("click", () => {
    if (currentFilter === filter || (filter === "all" && currentFilter === "all")) {
      currentFilter = "all";
    } else {
      currentFilter = filter;
    }
    updatePillActiveStates();
    applyFilter(currentFilter);
  });

  return btn;
}

function updatePillActiveStates() {
  document.querySelectorAll("#summary .pill").forEach((btn) => {
    const filter = btn.dataset.filter;
    const active =
      (currentFilter === "all" && filter === "all") ||
      (currentFilter !== "all" && filter === currentFilter);
    btn.classList.toggle("active", active);
  });
}

function applyFilter(filter) {
  document.querySelectorAll("#resultsBody tr").forEach((tr) => {
    const status = tr.dataset.status || "unknown";
    tr.style.display =
      filter === "all" || status === filter ? "" : "none";
  });
}

// -------------------- CSV export --------------------

function exportCurrentStudiesToCsv() {
  if (!currentStudies.length) return;

  const header = ["index", "status", "year", "title", "doi", "notes"];
  const rows = [header];

  currentStudies.forEach((s) => {
    rows.push([
      String(s.idx ?? ""),
      s.status ?? "",
      s.year != null ? String(s.year) : "",
      s.title ?? "",
      s.doi ?? "",
      s.notes ?? "",
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

// -------------------- Wire up events --------------------

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
      exportBtn.disabled = currentStudies.length === 0;
    }
  });

  exportBtn.addEventListener("click", () => {
    exportCurrentStudiesToCsv();
  });
}

// Script is loaded at the end of <body>, so DOM is ready
setup();
