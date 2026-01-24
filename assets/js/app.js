// Retraction Radar 2.0 – full app.js
// - Main article: Crossref + PubMed + Retraction Watch + OpenAlex is_retracted
// - References: only show retracted and problematic refs, but evaluate all
// - Designed to match OpenCitationTrajectory / Anesthesia TOC visual style

// ==================== CONFIG ====================

// PubMed API key (yours)
const PUBMED_API_KEY = "7d653c3573d4967a70f644df87ffbd392708";

// Optional polite parameter for OpenAlex
const OPENALEX_MAILTO = "name@example.org";

// Retraction Watch CSV (may fail in browser due to CORS; we fail soft)
const RW_CSV_URL =
  "https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv?ref_type=heads";

// ==================== GLOBAL STATE ====================

let lastAnalyzedDoi = "";
let currentInterestingRefs = []; // retracted + problematic only
let currentCounts = null;
let rwIndexPromise = null; // Promise<Set<string>>

// ==================== HELPERS ====================

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
    case "withdrawn":
      return statusTag("WITHDRAWN", "status-tag--eoc");
    case "corrected":
      return statusTag("CORRECTED / ERRATUM", "status-tag--clean");
    case "problem_no_doi":
      return statusTag("NO DOI", "status-tag--no-doi");
    case "problem_unknown":
      return statusTag("UNKNOWN", "status-tag--unknown");
    case "ok":
    default:
      return statusTag("OK", "status-tag--clean");
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

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// For ordering: retracted first, then problematic, then others
const STATUS_SCORE = {
  retracted: 5,
  expression_of_concern: 4,
  withdrawn: 4,
  corrected: 3,
  problem_no_doi: 2,
  problem_unknown: 1,
  ok: 0,
};

function compareBySeverity(a, b) {
  const sa = STATUS_SCORE[a.status] ?? 0;
  const sb = STATUS_SCORE[b.status] ?? 0;
  if (sa !== sb) return sb - sa;
  return a.idx - b.idx;
}

// ==================== RETRACTION WATCH CSV ====================

// Simple CSV line parser that respects quotes and commas in quoted fields
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
  // Your Apps Script uses OriginalPaperDOI; we accept that and plain "doi"
  const doiColIndex = header.findIndex((h) => {
    const t = String(h).trim().toLowerCase();
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
        console.warn(
          "Retraction Watch CSV could not be loaded (likely CORS or network):",
          err
        );
        return new Set(); // fail soft: acts as "no extra info"
      });
  }
  return rwIndexPromise;
}

async function isDoiInRetractionWatch(doi) {
  const index = await ensureRetractionWatchIndex();
  if (!index.size) return false;
  return index.has(normalizeDoi(doi));
}

// ==================== OPENALEX ====================

async function fetchOpenAlexWorkByDoi(doi) {
  const normalized = normalizeDoi(doi) || doi.trim();
  let url =
    "https://api.openalex.org/works/https://doi.org/" +
    encodeURIComponent(normalized);

  if (OPENALEX_MAILTO) {
    url += "?mailto=" + encodeURIComponent(OPENALEX_MAILTO);
  }

  const res = await fetch(url);
  if (res.status === 404) throw new Error("OpenAlex: DOI not found");
  if (!res.ok) throw new Error("OpenAlex work HTTP " + res.status);
  return res.json();
}

async function fetchOpenAlexWorkById(openAlexId) {
  const id = String(openAlexId).replace("https://openalex.org/", "");
  let url = "https://api.openalex.org/works/" + encodeURIComponent(id);
  if (OPENALEX_MAILTO) {
    url += "?mailto=" + encodeURIComponent(OPENALEX_MAILTO);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("OpenAlex ref HTTP " + res.status);
  return res.json();
}

function buildCitationFromOpenAlex(work) {
  if (!work) return "";

  const title = work.display_name || "";
  const year = work.publication_year || "";
  const venue = (work.host_venue && work.host_venue.display_name) || "";
  const biblio = work.biblio || {};
  const vol = biblio.volume || "";
  const issue = biblio.issue || "";
  const fp = biblio.first_page || "";
  const lp = biblio.last_page || "";
  const doi = work.doi || "";

  // authors (first 3)
  let authors = "";
  if (Array.isArray(work.authorships) && work.authorships.length > 0) {
    const names = work.authorships
      .map((a) =>
        a.author && a.author.display_name ? a.author.display_name : ""
      )
      .filter(Boolean);
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
  if (fp || lp) {
    let pages = fp || "";
    if (lp) pages += "-" + lp;
    yearBits.push("p. " + pages);
  }
  if (yearBits.length) parts.push(yearBits.join("; "));
  if (doi) parts.push("DOI: " + normalizeDoi(doi));
  return parts.join(" ");
}

// ==================== CROSSREF ====================

async function fetchCrossrefForDoi(doi) {
  const url =
    "https://api.crossref.org/works/" + encodeURIComponent(doi.trim());
  const res = await fetch(url);
  if (!res.ok) throw new Error("Crossref HTTP " + res.status);
  const json = await res.json();
  return json.message || {};
}

function determineRetractionStatusFromCrossref(message) {
  let status = "ok";
  const notes = [];

  const updateTo = message["update-to"] || message["update_to"] || [];
  if (Array.isArray(updateTo) && updateTo.length > 0) {
    for (const u of updateTo) {
      const updateType = (u["update-type"] || u["update_type"] || "")
        .toLowerCase();
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
    if (rel["is-retracted-by"]) {
      status = "retracted";
      notes.push("Crossref relation: is-retracted-by.");
    } else if (rel["has-retraction"]) {
      status = "retracted";
      notes.push("Crossref relation: has-retraction.");
    }
  }

  if (status === "ok" && notes.length === 0) {
    notes.push("Crossref: no retraction/correction signals.");
  }

  return { status, notes: notes.join(" ") };
}

async function getCrossrefRetractionInfoForDoi(doi) {
  try {
    const msg = await fetchCrossrefForDoi(doi);
    return determineRetractionStatusFromCrossref(msg);
  } catch (err) {
    console.warn("Crossref error for", doi, err);
    return { status: "unknown", notes: "Crossref error: " + err.message };
  }
}

// ==================== PUBMED (E-Utilities) ====================

// 1) DOI → PMID
async function fetchPubMedIdForDoi(doi) {
  const term = `${doi.trim()}[DOI]`;
  const url =
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" +
    `?db=pubmed&retmode=json&term=${encodeURIComponent(term)}` +
    `&api_key=${encodeURIComponent(PUBMED_API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("PubMed esearch HTTP " + res.status);
  const json = await res.json();
  const ids = (json.esearchresult && json.esearchresult.idlist) || [];
  if (!ids.length) return null;
  return ids[0];
}

// 2) PMID → summary
async function fetchPubMedSummaryForPmid(pmid) {
  const url =
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi" +
    `?db=pubmed&retmode=json&id=${encodeURIComponent(pmid)}` +
    `&api_key=${encodeURIComponent(PUBMED_API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("PubMed esummary HTTP " + res.status);
  const json = await res.json();
  if (!json.result || !json.result[pmid]) {
    throw new Error("PubMed esummary: missing result");
  }
  return json.result[pmid];
}

function determineRetractionStatusFromPubMedSummary(pmid, summary) {
  const pubtypes = summary.pubtype || [];
  const ptLower = pubtypes.map((p) => String(p).toLowerCase());
  let status = "ok";
  const notes = [];

  for (const pt of ptLower) {
    if (pt.includes("retracted publication")) {
      status = "retracted";
      notes.push("PubMed: publication type = Retracted Publication.");
      break;
    }
    if (pt.includes("retraction of publication")) {
      status = "retracted";
      notes.push("PubMed: publication type = Retraction of Publication.");
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
      if (status === "ok") status = "corrected";
      notes.push("PubMed: publication type indicates correction/erratum.");
    }
  }

  if (status === "ok" && notes.length === 0) {
    notes.push("PubMed: no retraction-related publication types.");
  }

  return { status, notes: notes.join(" "), pmid };
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
    console.warn("PubMed error for", doi, err);
    return { status: "unknown", notes: "PubMed error: " + err.message, pmid: null };
  }
}

// ==================== COMBINED STATUS ====================

function pickMoreSevere(a, b) {
  const sa = STATUS_SCORE[a] ?? 0;
  const sb = STATUS_SCORE[b] ?? 0;
  return sa >= sb ? a : b;
}

async function getCombinedRetractionInfoForDoi(doi, isRetractedOpenAlex) {
  const [cr, pm, rwHit] = await Promise.all([
    getCrossrefRetractionInfoForDoi(doi),
    getPubMedRetractionInfoForDoi(doi),
    isDoiInRetractionWatch(doi),
  ]);

  let status = pickMoreSevere(cr.status, pm.status);
  let notes = [cr.notes, pm.notes].filter(Boolean);

  if (rwHit) {
    status = pickMoreSevere(status, "retracted");
    notes.push("Retraction Watch CSV: DOI present.");
  }

  if (isRetractedOpenAlex) {
    status = pickMoreSevere(status, "retracted");
    notes.push("OpenAlex: is_retracted = true.");
  }

  if (pm.pmid) notes.push(`PubMed PMID: ${pm.pmid}.`);

  return { status, notes: notes.join(" ") };
}

// ==================== REFERENCE CLASSIFIERS ====================

function classifyReferenceError(idx, openAlexId, errorMessage) {
  const shortId = (openAlexId || "").replace("https://openalex.org/", "");
  return {
    idx,
    title: `Reference unavailable in OpenAlex (ID: ${shortId})`,
    year: "",
    doi: null,
    openAlexId,
    status: "problem_unknown",
    notes:
      "Error fetching OpenAlex work for this reference: " +
      (errorMessage || "unknown error"),
    citation: "",
  };
}

async function classifyReferenceFromWork(idx, work) {
  const refDoi = work.doi || null;
  const citation = buildCitationFromOpenAlex(work);
  const year = work.publication_year || "";
  const title = work.display_name || "";
  const openAlexId = work.id || "";

  if (!refDoi) {
    return {
      idx,
      title,
      year,
      doi: null,
      openAlexId,
      status: "problem_no_doi",
      notes: "No DOI available; cannot check Crossref/PubMed/Retraction Watch.",
      citation,
    };
  }

  const retInfo = await getCombinedRetractionInfoForDoi(refDoi, !!work.is_retracted);
  let status = retInfo.status;

  if (!STATUS_SCORE[status]) status = "ok";

  return {
    idx,
    title,
    year,
    doi: refDoi,
    openAlexId,
    status,
    notes: retInfo.notes,
    citation,
  };
}

// ==================== MAIN ANALYSIS FLOW ====================

function normalizeDoiInput(raw) {
  if (!raw) return "";
  const trimmed = raw.trim();

  // Extract from doi.org URL
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const parts = trimmed.split("doi.org/");
    if (parts.length > 1) return normalizeDoi(parts[1]);
  }

  const idx = trimmed.indexOf("10.");
  if (idx >= 0) return normalizeDoi(trimmed.slice(idx));

  return normalizeDoi(trimmed);
}

async function analyzeDoi(rawInput) {
  const doi = normalizeDoiInput(rawInput);
  lastAnalyzedDoi = doi || rawInput.trim();

  const resultsBody = $("resultsBody");
  const exportBtn = $("exportCsvBtn");
  const metaInfo = $("metaInfo");
  const metaStatusEl = $("metaStatus");
  const summaryWrapper = $("summaryWrapper");

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

  // Preload RW index (best effort) in parallel
  ensureRetractionWatchIndex().catch(() => {});

  setStatus("Resolving DOI via OpenAlex…");

  // 1) Main article
  const work = await fetchOpenAlexWorkByDoi(doi);
  const rawTitle = work.display_name || "(no title)";
  const year = work.publication_year || "";
  const workDoi = work.doi || doi;
  const refIds = work.referenced_works || [];

  $("metaYear").textContent = year || "–";
  $("metaDoi").textContent = workDoi || "–";
  $("metaRefCount").textContent = refIds.length;
  metaInfo.classList.remove("hidden");

  // Combined retraction status for main article
  setStatus("Checking retraction status of the main article…");
  const mainInfo = await getCombinedRetractionInfoForDoi(
    workDoi,
    !!work.is_retracted
  );

  const isClearlyRetracted =
    mainInfo.status === "retracted" ||
    mainInfo.status === "expression_of_concern" ||
    mainInfo.status === "withdrawn";

  const metaTitleSpan = $("metaTitle");
  if (isClearlyRetracted) {
    const chipHtml = statusTag("RETRACTED", "status-tag--retracted");
    metaTitleSpan.innerHTML = chipHtml + " " + escapeHtml(rawTitle);
  } else if (mainInfo.status === "corrected") {
    const chipHtml = statusTag("CORRECTED / ERRATUM", "status-tag--clean");
    metaTitleSpan.innerHTML = chipHtml + " " + escapeHtml(rawTitle);
  } else {
    metaTitleSpan.textContent = rawTitle;
  }

  // Optional secondary line in the meta card
  if (metaStatusEl) {
    if (isClearlyRetracted) {
      metaStatusEl.textContent =
        "This article itself is retracted or has an expression of concern/withdrawal notice.";
    } else if (mainInfo.status === "corrected") {
      metaStatusEl.textContent =
        "This article has a correction / erratum but is not flagged as fully retracted.";
    } else {
      metaStatusEl.textContent =
        "This article is not flagged as retracted in Crossref/PubMed/Retraction Watch/OpenAlex.";
    }
  }

  if (!refIds.length) {
    setStatus("OpenAlex: this work lists 0 referenced works.");
    return;
  }

  setStatus(
    `Found ${refIds.length} referenced works. Checking retractions via Crossref/PubMed/Retraction Watch…`
  );

  // 2) References (sequential; reliable, avoids HTTP 400)
  const allRefs = [];
  let idxCounter = 0;

  for (const refId of refIds) {
    idxCounter++;
    try {
      const refWork = await fetchOpenAlexWorkById(refId);
      const refObj = await classifyReferenceFromWork(idxCounter, refWork);
      allRefs.push(refObj);
    } catch (err) {
      console.warn("Error fetching reference", refId, err);
      allRefs.push(
        classifyReferenceError(idxCounter, refId, err.message || "fetch error")
      );
    }

    if (idxCounter % 10 === 0) {
      setStatus(
        `Checked ${idxCounter}/${refIds.length} references… still working.`
      );
    }
  }

  // 3) Aggregate counts & select interesting refs
  const counts = {
    total: allRefs.length,
    retracted: 0,
    expression_of_concern: 0,
    withdrawn: 0,
    corrected: 0,
    problem_no_doi: 0,
    problem_unknown: 0,
    ok: 0,
  };

  allRefs.forEach((r) => {
    if (counts[r.status] !== undefined) counts[r.status]++;
    else counts.ok++;
  });

  const interesting = allRefs.filter(
    (r) => r.status !== "ok" // only show retracted/problematic
  );
  interesting.sort(compareBySeverity);

  currentInterestingRefs = interesting;
  currentCounts = counts;

  // 4) Render table
  resultsBody.innerHTML = "";

  if (!interesting.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="6" style="padding:0.75rem;color:#9ca3af;">No retracted or problematic references detected. All references appear OK according to Crossref/PubMed/Retraction Watch (but manual verification is still recommended).</td>';
    resultsBody.appendChild(tr);
  } else {
    interesting.forEach((ref) => appendRefRow(ref));
  }

  // 5) Summary pills
  renderSummaryPills(counts);
  summaryWrapper.classList.remove("hidden");
  exportBtn.disabled = currentInterestingRefs.length === 0;

  const totalRetLike =
    counts.retracted + counts.expression_of_concern + counts.withdrawn;

  if (totalRetLike > 0) {
    setStatus(
      `Finished. Found ${totalRetLike} retracted/EoC/withdrawn references; ${
        counts.problem_no_doi + counts.problem_unknown
      } problematic (no DOI / unknown) among ${counts.total} total.`
    );
  } else {
    setStatus(
      `Finished. No retracted or EoC/withdrawn references detected via Crossref/PubMed/Retraction Watch among ${counts.total} total. ${
        counts.problem_no_doi + counts.problem_unknown
      } references are problematic (no DOI / unknown).`
    );
  }
}

// ==================== RENDERING ====================

function appendRefRow(ref) {
  const tbody = $("resultsBody");
  const tr = document.createElement("tr");
  tr.dataset.status = ref.status;

  let linkHtml = "—";
  if (ref.doi) {
    const norm = normalizeDoi(ref.doi);
    linkHtml = `<a href="https://doi.org/${encodeURIComponent(
      norm
    )}" target="_blank" rel="noopener noreferrer" class="doi-link">${norm}</a>`;
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

  function pill(label, value, muted) {
    const div = document.createElement("div");
    div.className =
      "pill pill--static" + (muted ? " pill--muted" : "");
    div.innerHTML = `
      <span class="pill-label">${label}</span>
      <span class="pill-count">${value}</span>
    `;
    return div;
  }

  const totalProblem =
    (counts.problem_no_doi || 0) + (counts.problem_unknown || 0);
  const totalRetLike =
    counts.retracted + counts.expression_of_concern + counts.withdrawn;

  summary.appendChild(pill("Total references", counts.total, false));
  summary.appendChild(
    pill("Retracted / EoC / withdrawn", totalRetLike, totalRetLike === 0)
  );
  summary.appendChild(
    pill(
      "Problematic (no DOI / unknown)",
      totalProblem,
      totalProblem === 0
    )
  );
  summary.appendChild(
    pill(
      "OK (not listed below)",
      counts.total - (totalRetLike + totalProblem),
      true
    )
  );
}

// ==================== CSV EXPORT ====================

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
    const linkField = r.doi ? normalizeDoi(r.doi) : r.openAlexId || "";
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

// ==================== WIRING ====================

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

// Script loaded at end of <body>, so DOM is ready
setup();

