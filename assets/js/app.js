// assets/js/app.js

let currentFilter = "all";
let currentStudies = [];        // all rows for the current analysis
let lastAnalyzedDoi = "";       // for CSV filename

// --- Helpers ---------------------------------------------------------

function setStatus(message, isError = false) {
  const el = document.getElementById("status");
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

// --- OpenAlex --------------------------------------------------------

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

// --- Crossref retraction check --------------------------------------

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
    notes.push("No retraction/correction signals found in Crossref updates.");
  }

  return {
    status,
    notes: notes.join(" "),
  };
}

async function getRetractionInfoForDoi(doi) {
  try {
    const message = await fetchCrossrefForDoi(doi);
    return determineRetractionStatusFromCrossref(message);
  } catch (err) {
    console.error("Error checking Crossref", doi, err);
    return {
      status: "unknown",
      notes: "Error querying Crossref: " + err.message,
    };
  }
}

// --- Main workflow ---------------------------------------------------

async function analyzeDoi(doiRaw) {
  const doi = normalizeDoiInput(doiRaw);
  lastAnalyzedDoi = doi || doiRaw.trim();

  const resultsBody = document.getElementById("resultsBody");
  const exportBtn = document.getElementById("exportCsvBtn");
  resultsBody.innerHTML = "";
  currentStudies = [];
  document.getElementById("metaInfo").classList.add("hidden");
  document.getElementById("summaryWrapper").classList.add("hidden");
  currentFilter = "all";
  exportBtn.disabled = true;

  setStatus("Resolving DOI via OpenAlex…");

  const work = await fetchOpenAlexWorkByDoi(doi || doiRaw.trim());

  const title = work.display_name || "(no title)";
  const year = work.publication_year || "";
  const workDoi = work.doi || (doi || doiRaw.trim());
  const referenced = work.referenced_works || [];

  document.getElementById("metaTitle").textContent = title;
  document.getElementById("metaYear").textContent = year || "–";
  document.getElementById("metaDoi").textContent = workDoi || "–";
  document.getElementById("metaRefCount").textContent = referenced.length;
  document.getElementById("metaInfo").classList.remove("hidden");

  if (!referenced.length) {
    setStatus(
      "This work has no referenced_works in OpenAlex. Nothing to check.",
      false
    );
    return;
  }

  setStatus(
    `Found ${referenced.length} referenced works in OpenAlex. Fetching metadata and retraction status…`
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
        retractionStatus = await getRetractionInfoForDoi(refDoi);
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
          `Checked ${index}/${truncated.length} references… still working.`
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
  document.getElementById("summaryWrapper").classList.remove("hidden");
  exportBtn.disabled = currentStudies.length === 0;

  if (counts.retracted > 0 || counts.expression_of_concern > 0) {
    setStatus(
      `Finished. Found ${counts.retracted} retracted and ${counts.expression_of_concern} with expression of concern among ${counts.total} cited works.`,
      false
    );
  } else {
    setStatus(
      `Finished. No retracted or EoC signals detected via Crossref among ${counts.total} cited works. Always double-check manually.`,
      false
    );
  }
}

function appendStudyRow(study) {
  const tbody = document.getElementById("resultsBody");
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

// --- Summary + filter logic -----------------------------------------

function renderSummary(counts) {
  const summary = document.getElementById("summary");
  summary.innerHTML = "";

  const pills = [];

  pills.push(makePill("all", "Total", counts.total));

  if (counts.retracted > 0) {
    pills.push(makePill("retracted", "Retracted", counts.retracted));
  }
  if (counts.expression_of_concern > 0) {
    pills.push(
      makePill("expression_of_concern", "Expression of concern", counts.expression_of_concern)
    );
  }
  if (counts.corrected > 0) {
    pills.push(
      makePill("corrected", "Corrected / Erratum", counts.corrected)
    );
  }
  if (counts.withdrawn > 0) {
    pills.push(makePill("withdrawn", "Withdrawn", counts.withdrawn));
  }
  if (counts.no_doi > 0) {
    pills.push(makePill("no_doi", "No DOI", counts.no_doi));
  }
  if (counts.unknown > 0) {
    pills.push(makePill("unknown", "Unknown", counts.unknown));
  }

  pills.forEach((btn) => summary.appendChild(btn));
  updatePillActiveStates();
}

function makePill(filter, label, count) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pill";
  btn.setAttribute("data-filter", filter);
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
  document
    .querySelectorAll("#summary .pill")
    .forEach((btn) => {
      const filter = btn.getAttribute("data-filter");
      const active =
        (currentFilter === "all" && filter === "all") ||
        (currentFilter !== "all" && filter === currentFilter);
      btn.classList.toggle("active", active);
    });
}

function applyFilter(filter) {
  const rows = document.querySelectorAll("#resultsBody tr");
  rows.forEach((tr) => {
    const status = tr.dataset.status || "unknown";
    if (filter === "all" || status === filter) {
      tr.style.display = "";
    } else {
      tr.style.display = "none";
    }
  });
}

// --- CSV export ------------------------------------------------------

function normalizeDoiInput(raw) {
  if (!raw) return "";
  const trimmed = raw.trim();
  const doiPrefix = "10.";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const parts = trimmed.split("doi.org/");
    if (parts.length > 1) {
      return parts[1].trim();
    }
  }
  // already plain DOI?
  const idx = trimmed.indexOf(doiPrefix);
  if (idx >= 0) {
    return trimmed.slice(idx);
  }
  return trimmed;
}

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
          const v = (val ?? "").replace(/"/g, '""');
          return `"${v}"`;
        })
        .join(",")
    )
    .join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const safeDoi =
    (lastAnalyzedDoi || "results")
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 80) || "results";

  const a = document.createElement("a");
  a.href = url;
  a.download = `retraction-radar-${safeDoi}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Wiring ----------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("doiForm");
  const input = document.getElementById("doiInput");
  const button = document.getElementById("analyzeBtn");
  const exportBtn = document.getElementById("exportCsvBtn");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const doi = input.value.trim();
    if (!doi) return;

    button.disabled = true;
    exportBtn.disabled = true;
    setStatus("");

    try {
      await analyzeDoi(doi);
    } catch (err) {
      console.error(err);
      setStatus("Error: " + err.message, true);
    } finally {
      button.disabled = false;
      exportBtn.disabled = currentStudies.length === 0;
    }
  });

  exportBtn.addEventListener("click", () => {
    exportCurrentStudiesToCsv();
  });
});
