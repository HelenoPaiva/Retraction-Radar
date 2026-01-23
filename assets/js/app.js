// assets/js/app.js

// --- Helpers ---------------------------------------------------------

function setStatus(message, isError = false) {
  const el = document.getElementById("status");
  el.textContent = message;
  el.className =
    "text-sm mt-1 " +
    (isError ? "text-red-700" : "text-slate-600");
}

function badge(label, colorClasses) {
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${colorClasses}">${label}</span>`;
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
  // openAlexId can be a full URL like "https://openalex.org/W123..."
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
  // Default
  let status = "ok";
  let notes = [];

  // 1) "update-to" array is where Crossref often encodes retractions / corrections
  const updateTo = message["update-to"] || message["update_to"] || [];
  if (Array.isArray(updateTo) && updateTo.length > 0) {
    for (const u of updateTo) {
      const updateType = (u["update-type"] || u["update_type"] || "").toLowerCase();
      if (updateType.includes("retract")) {
        status = "retracted";
        notes.push("Crossref: update-type = retraction");
      } else if (updateType.includes("expression")) {
        status = "expression_of_concern";
        notes.push("Crossref: update-type = expression of concern");
      } else if (
        updateType.includes("correction") ||
        updateType.includes("erratum")
      ) {
        // Only set if not already retracted/EoC
        if (status === "ok") {
          status = "corrected";
        }
        notes.push("Crossref: update-type = correction/erratum");
      } else if (updateType.includes("withdraw")) {
        if (status === "ok") {
          status = "withdrawn";
        }
        notes.push("Crossref: update-type = withdrawal");
      }
    }
  }

  // 2) relation: is-retracted-by etc.
  if (message.relation) {
    const rel = message.relation;
    if (rel["is-retracted-by"] || rel["is-retracted-by:"]) {
      status = "retracted";
      notes.push("Crossref: relation = is-retracted-by");
    } else if (rel["has-retraction"] || rel["has-retraction:"]) {
      status = "retracted";
      notes.push("Crossref: relation = has-retraction");
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
  // Reset UI
  const resultsBody = document.getElementById("resultsBody");
  resultsBody.innerHTML = "";
  document.getElementById("summary").classList.add("hidden");
  document.getElementById("metaInfo").classList.add("hidden");

  setStatus("Resolving DOI via OpenAlex…");

  // 1. Fetch the main article
  const work = await fetchOpenAlexWorkByDoi(doi);

  const title = work.display_name || "(no title)";
  const year = work.publication_year || "";
  const workDoi = work.doi || doi;
  const referenced = work.referenced_works || [];

  // Update meta info panel
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

  // 2. Fetch referenced works metadata in batches
  const maxRefs = 200; // safety cap for the MVP
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

      studies.push({
        idx: index,
        title: refTitle,
        year: refYear,
        doi: refDoi,
        status: retractionStatus.status,
        notes: retractionStatus.notes,
      });

      // Render row as we go
      appendStudyRow(studies[studies.length - 1]);

      // Update inline status occasionally
      if (index % 10 === 0) {
        setStatus(
          `Checked ${index}/${truncated.length} references… still working.`
        );
      }
    } catch (err) {
      console.error("Error processing reference", refId, err);
      studies.push({
        idx: index,
        title: "(error fetching reference)",
        year: "",
        doi: null,
        status: "unknown",
        notes: "Error fetching OpenAlex work for this reference.",
      });
      appendStudyRow(studies[studies.length - 1]);
    }
  }

  // 3. Build summary
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

  // Final status line
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

  const doiLink =
    study.doi
      ? `<a href="https://doi.org/${encodeURIComponent(
          study.doi
        )}" target="_blank" rel="noopener noreferrer" class="text-emerald-700 hover:underline">${study.doi}</a>`
      : "–";

  tr.innerHTML = `
    <td class="px-3 py-2 align-top text-[11px] text-slate-500">${study.idx}</td>
    <td class="px-3 py-2 align-top">${mapStatusToBadge(study.status)}</td>
    <td class="px-3 py-2 align-top text-[11px] text-slate-600">${study.year || "–"}</td>
    <td class="px-3 py-2 align-top text-[11px]">
      <div class="max-w-xs break-words">${study.title}</div>
    </td>
    <td class="px-3 py-2 align-top text-[11px]">${doiLink}</td>
    <td class="px-3 py-2 align-top text-[11px] text-slate-500">
      <div class="max-w-xs break-words">${study.notes}</div>
    </td>
  `;

  tbody.appendChild(tr);
}

function renderSummary(counts) {
  const summary = document.getElementById("summary");
  summary.innerHTML = "";

  const pills = [];

  pills.push(
    `<div class="inline-flex items-center gap-1 rounded-full bg-slate-900 text-slate-50 px-2.5 py-1">
      <span class="text-[11px] font-semibold">Total</span>
      <span class="text-xs">${counts.total}</span>
    </div>`
  );

  if (counts.retracted > 0) {
    pills.push(
      `<div class="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-800 px-2.5 py-1 border border-red-200">
        <span class="text-[11px] font-semibold">Retracted</span>
        <span class="text-xs">${counts.retracted}</span>
      </div>`
    );
  }

  if (counts.expression_of_concern > 0) {
    pills.push(
      `<div class="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 px-2.5 py-1 border border-amber-200">
        <span class="text-[11px] font-semibold">Expression of concern</span>
        <span class="text-xs">${counts.expression_of_concern}</span>
      </div>`
    );
  }

  if (counts.corrected > 0) {
    pills.push(
      `<div class="inline-flex items-center gap-1 rounded-full bg-blue-100 text-blue-800 px-2.5 py-1 border border-blue-200">
        <span class="text-[11px] font-semibold">Corrected / Erratum</span>
        <span class="text-xs">${counts.corrected}</span>
      </div>`
    );
  }

  if (counts.withdrawn > 0) {
    pills.push(
      `<div class="inline-flex items-center gap-1 rounded-full bg-rose-100 text-rose-800 px-2.5 py-1 border border-rose-200">
        <span class="text-[11px] font-semibold">Withdrawn</span>
        <span class="text-xs">${counts.withdrawn}</span>
      </div>`
    );
  }

  if (counts.no_doi > 0) {
    pills.push(
      `<div class="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-700 px-2.5 py-1 border border-slate-200">
        <span class="text-[11px] font-semibold">No DOI</span>
        <span class="text-xs">${counts.no_doi}</span>
      </div>`
    );
  }

  if (counts.unknown > 0) {
    pills.push(
      `<div class="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-700 px-2.5 py-1 border border-slate-200">
        <span class="text-[11px] font-semibold">Unknown</span>
        <span class="text-xs">${counts.unknown}</span>
      </div>`
    );
  }

  summary.innerHTML = pills.join("");
  summary.classList.remove("hidden");
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
