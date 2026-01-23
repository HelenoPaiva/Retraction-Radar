// assets/js/app.js

// Global current filter
let currentFilter = "all";

// --- Helpers ---------------------------------------------------------

function setStatus(message, isError = false) {
  const el = document.getElementById("status");
  el.textContent = message;
  el.className =
    "text-xs sm:text-sm mt-1 " +
    (isError ? "text-red-700" : "text-slate-600");
}

function badge(label, colorClasses) {
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${colorClasses}">${label}</span>`;
}

function mapStatusToBadge(status) {
  switch (status) {
    case "retracted":
      return badge("RETRACTED", "bg-red-100 text-red-800 border border-red-200");
    case "expression_of_concern":
      return badge("EXPRESSION OF CONCERN", "bg-amber-100 text-amber-800 border border-amber-200");
    case "corrected":
      return badge("CORRECTED / ERRATUM", "bg-blue-100 text-blue-800 border border-blue-200");
    case "withdrawn":
      return badge("WITHDRAWN", "bg-rose-100 text-rose-800 border border-rose-200");
    case "no_doi":
      return badge("NO DOI", "bg-slate-100 text-slate-700 border border-slate-200");
    case "unknown":
      return badge("UNKNOWN", "bg-slate-100 text-slate-700 border border-slate-200");
    case "ok":
    default:
      return badge("OK", "bg-emerald-100 text-emerald-800 border border-emerald-200");
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
  let notes = [];

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

async function analyzeDoi(doi) {
  const resultsBody = document.getElementById("resultsBody");
  resultsBody.innerHTML = "";
  document.getElementById("summaryWrapper").classList.add("hidden");
  document.getElementById("metaInfo").classList.add("hidden");
  currentFilter = "all";

  setStatus("Resolving DOI via OpenAlex…");

  const work = await fetchOpenAlexWorkByDoi(doi);

  const title = work.display_name || "(no title)";
  const year = work.publication_year || "";
  const workDoi = work.doi || doi;
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

  const maxRefs = 200; // safety cap
  const truncated = referenced.slice(0, maxRefs);
  const studies = [];

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

      studies.push(study);
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
      studies.push(study);
      appendStudyRow(study);
    }
  }

  const counts = {
    total: studies.length,
    ok: 0,
    retracted: 0,
    expression_of_concern: 0,
    corrected: 0,
    withdrawn: 0,
    no_doi: 0,
    unknown: 0,
  };

  for (const s of studies) {
    if (counts[s.status] !== undefined) {
      counts[s.status] += 1;
    } else {
      counts.unknown += 1;
    }
  }

  renderSummary(counts);
  document.getElementById("summaryWrapper").classList.remove("hidden");

  if (counts.retracted > 0 || counts.expression_of_concern > 0) {
    setStatus(
      `Finished. ⚠️ Found ${counts.retracted} retracted and ${counts.expression_of_concern} with expression of concern among ${counts.total} cited works. Please review manually.`,
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
  tr.className = "border-b border-slate-100 hover:bg-slate-50";
  tr.dataset.status = study.status;

  const doiLink =
    study.doi
      ? `<a href="https://doi.org/${encodeURIComponent(
          study.doi
        )}" target="_blank" rel="noopener noreferrer" class="text-emerald-700 hover:underline">${study.doi}</a>`
      : "–";

  tr.innerHTML = `
    <td class="px-3 py-2 align-top text-[10px] text-slate-500">${study.idx}</td>
    <td class="px-3 py-2 align-top">${mapStatusToBadge(study.status)}</td>
    <td class="px-3 py-2 align-top text-[10px] text-slate-600">${study.year || "–"}</td>
    <td class="px-3 py-2 align-top">
      <div class="max-w-xs sm:max-w-sm break-words">${study.title}</div>
    </td>
    <td class="px-3 py-2 align-top">${doiLink}</td>
    <td class="px-3 py-2 align-top text-[10px] text-slate-500">
      <div class="max-w-xs sm:max-w-sm break-words">${study.notes}</div>
    </td>
  `;

  tbody.appendChild(tr);
}

// --- Summary + filter logic -----------------------------------------

function renderSummary(counts) {
  const summary = document.getElementById("summary");
  summary.innerHTML = "";

  const pills = [];

  // Total pill (clears filter)
  pills.push(
    `<button type="button"
       class="pill-base bg-slate-900 text-slate-50"
       data-filter="all">
      <span class="text-[11px] font-semibold">Total</span>
      <span class="text-xs">${counts.total}</span>
    </button>`
  );

  if (counts.retracted > 0) {
    pills.push(
      `<button type="button"
         class="pill-base bg-red-100 text-red-800 border border-red-200"
         data-filter="retracted">
        <span class="text-[11px] font-semibold">Retracted</span>
        <span class="text-xs">${counts.retracted}</span>
      </button>`
    );
  }

  if (counts.expression_of_concern > 0) {
    pills.push(
      `<button type="button"
         class="pill-base bg-amber-100 text-amber-800 border border-amber-200"
         data-filter="expression_of_concern">
        <span class="text-[11px] font-semibold">Expression of concern</span>
        <span class="text-xs">${counts.expression_of_concern}</span>
      </button>`
    );
  }

  if (counts.corrected > 0) {
    pills.push(
      `<button type="button"
         class="pill-base bg-blue-100 text-blue-800 border border-blue-200"
         data-filter="corrected">
        <span class="text-[11px] font-semibold">Corrected / Erratum</span>
        <span class="text-xs">${counts.corrected}</span>
      </button>`
    );
  }

  if (counts.withdrawn > 0) {
    pills.push(
      `<button type="button"
         class="pill-base bg-rose-100 text-rose-800 border border-rose-200"
         data-filter="withdrawn">
        <span class="text-[11px] font-semibold">Withdrawn</span>
        <span class="text-xs">${counts.withdrawn}</span>
      </button>`
    );
  }

  if (counts.no_doi > 0) {
    pills.push(
      `<button type="button"
         class="pill-base bg-slate-100 text-slate-700 border border-slate-200"
         data-filter="no_doi">
        <span class="text-[11px] font-semibold">No DOI</span>
        <span class="text-xs">${counts.no_doi}</span>
      </button>`
    );
  }

  if (counts.unknown > 0) {
    pills.push(
      `<button type="button"
         class="pill-base bg-slate-100 text-slate-700 border border-slate-200"
         data-filter="unknown">
        <span class="text-[11px] font-semibold">Unknown</span>
        <span class="text-xs">${counts.unknown}</span>
      </button>`
    );
  }

  // Base pill style (using class name we can target from JS)
  const pillBaseClass =
    "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs cursor-pointer transition ring-0 ring-emerald-500/0 hover:ring-2 hover:ring-emerald-500/50";

  summary.innerHTML = pills.join("");

  // Ensure all pills have pillBaseClass (because they were built as strings)
  summary.querySelectorAll("button").forEach((btn) => {
    if (!btn.classList.contains("pill-base")) {
      btn.classList.add("pill-base");
    }
  });

  // Wire click handlers for filtering
  summary.querySelectorAll("button[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const filter = btn.getAttribute("data-filter");
      if (currentFilter === filter) {
        // Clicking the same pill again clears filter (back to "all")
        currentFilter = "all";
      } else {
        currentFilter = filter;
      }
      updatePillActiveStates();
      applyFilter(currentFilter);
    });
  });

  // Initial state: "all" active
  updatePillActiveStates();
}

function updatePillActiveStates() {
  const summary = document.getElementById("summary");
  summary.querySelectorAll("button[data-filter]").forEach((btn) => {
    const filter = btn.getAttribute("data-filter");
    if (currentFilter === filter || (currentFilter === "all" && filter === "all")) {
      btn.classList.add("ring-2", "ring-emerald-500");
    } else {
      btn.classList.remove("ring-2", "ring-emerald-500");
    }
  });
}

function applyFilter(filter) {
  const rows = document.querySelectorAll("#resultsBody tr");
  rows.forEach((tr) => {
    const status = tr.dataset.status || "unknown";
    if (filter === "all" || status === filter) {
      tr.classList.remove("hidden");
    } else {
      tr.classList.add("hidden");
    }
  });
}

// --- Wiring ----------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("doiForm");
  const input = document.getElementById("doiInput");
  const button = document.getElementById("analyzeBtn");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const doi = input.value.trim();
    if (!doi) return;

    button.disabled = true;
    button.classList.add("opacity-70", "cursor-not-allowed");
    setStatus("");

    try {
      await analyzeDoi(doi);
    } catch (err) {
      console.error(err);
      setStatus("Error: " + err.message, true);
    } finally {
      button.disabled = false;
      button.classList.remove("opacity-70", "cursor-not-allowed");
    }
  });
});

