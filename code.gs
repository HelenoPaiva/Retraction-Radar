// ==========================================
// Retraction Radar – Citation-level version
// Goal: For each DOI in column K, answer:
//  "Does this paper CITE retracted literature?"
// 
// Uses:
//  - Retraction Watch DOI index (plain text in your GitHub repo)
//    → to detect self-retraction and retracted cited DOIs
//  - OpenAlex:
//    → to resolve references (referenced_works) and is_retracted flags
// 
// Sheet layout:
//  - K: DOI
//  - L: Status
//  - M: Reason / details
//  - N: Number of references evaluated
//  - O: Retracted DOIs found (comma-separated)
// ==========================================

// ===== CONFIG =====
var COL_DOI = 11;              // Column K
var COL_STATUS = 12;           // Column L
var COL_REASON = 13;           // Column M
var COL_REFS = 14;             // Column N
var COL_RETRACTED_DOIS = 15;   // Column O

var HEADER_ROW = 1;

// Batch + runtime safety
var BATCH_SIZE = 5;                 // how many DOIs per run
var MAX_RUNTIME_MS = 5 * 60 * 1000; // 5 minutes
var PER_DOI_SLEEP_MS = 1500;        // ms pause between DOIs

// OpenAlex polite parameter (optional but recommended)
var OPENALEX_MAILTO = "name@example.org"; // you can put your email here, or leave as-is

// Retraction Watch DOI index URL – your GitHub mirror (plain text, one DOI per line)
var RETRACTION_WATCH_INDEX_URL =
  "https://raw.githubusercontent.com/HelenoPaiva/Retraction-Radar/refs/heads/main/data/retraction_watch_doi_index.txt";

// In-memory cache for Retraction Watch DOIs (per execution)
var RW_CACHE = null; // { error: string|null, map: { [normalizedDoi]: true } }

// ===== MENU =====
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Retraction Radar")
    .addItem("Process next batch (" + BATCH_SIZE + ")", "processNextBatch")
    .addItem("Process ALL remaining", "processAllRemaining")
    .addSeparator()
    .addItem("Reset results (L-O)", "resetResults")
    .addToUi();
}

function processNextBatch() {
  processBatch_(BATCH_SIZE);
}

function processAllRemaining() {
  var start = Date.now();
  while (true) {
    var didWork = processBatch_(BATCH_SIZE, true);
    if (!didWork) {
      break;
    }
    if (Date.now() - start > MAX_RUNTIME_MS) {
      break;
    }
  }
}

function resetResults() {
  var sh = SpreadsheetApp.getActiveSheet();
  var lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW) {
    return;
  }
  var numRows = lastRow - HEADER_ROW;
  var numCols = COL_RETRACTED_DOIS - COL_STATUS + 1;
  sh.getRange(HEADER_ROW + 1, COL_STATUS, numRows, numCols).clearContent();
}

// ===== BATCH LOOP =====
function processBatch_(limit, silent) {
  if (limit == null) {
    limit = BATCH_SIZE;
  }
  if (silent == null) {
    silent = false;
  }

  var sh = SpreadsheetApp.getActiveSheet();
  var lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW) {
    return false;
  }

  var numRows = lastRow - HEADER_ROW;
  var numCols = COL_RETRACTED_DOIS;
  var data = sh.getRange(HEADER_ROW + 1, 1, numRows, numCols).getValues();

  var startTime = Date.now();
  var processed = 0;

  // Ensure Retraction Watch cache is loaded (only once per execution)
  var rw = getRetractionWatchCache_();
  if (rw.error) {
    SpreadsheetApp.getActive().toast(
      "Retraction Radar: ERROR loading Retraction Watch index – " + rw.error,
      "Error",
      6
    );
    // We still proceed, but only with OpenAlex is_retracted if available
  }

  for (var i = 0; i < data.length; i++) {
    var rowIndex = HEADER_ROW + 1 + i;
    var row = data[i];

    var doi = row[COL_DOI - 1];
    var status = row[COL_STATUS - 1];

    // Skip if DOI empty or already processed
    if (!doi || String(doi).trim() === "" || status) {
      continue;
    }

    // Runtime safety margin (~20s)
    if (Date.now() - startTime > MAX_RUNTIME_MS - 20000) {
      break;
    }

    var doiStr = String(doi).trim();
    var result = checkReferencesForDoi_(doiStr, rw);

    sh.getRange(rowIndex, COL_STATUS, 1, 4).setValues([[
      result.statusLabel,
      result.reason,
      result.referencesEvaluated,
      result.retractedDoisText
    ]]);

    processed++;
    Utilities.sleep(PER_DOI_SLEEP_MS);

    if (processed >= limit) {
      break;
    }
  }

  if (!silent && processed > 0) {
    SpreadsheetApp.getActive().toast(
      "Retraction Radar: processed " + processed + " DOI(s).",
      "Done",
      4
    );
  }

  return processed > 0;
}

// ===== CORE LOGIC: for one DOI =====
function checkReferencesForDoi_(doi, rwCache) {
  // --- Fast path – check self against Retraction Watch DOI index first ---
  var selfRetractedRW = false;
  if (rwCache && rwCache.map) {
    var normSelf = normalizeDoi_(doi);
    if (normSelf && rwCache.map[normSelf]) {
      selfRetractedRW = true;
    }
  }

  if (selfRetractedRW) {
    // If RW already says this DOI is retracted, short-circuit:
    // - No need to call OpenAlex for self status
    // - No need to resolve references (for speed)
    return {
      statusLabel: "RETRACTED",
      reason: "Self: retracted (Retraction Watch index) | References: not evaluated (RW short-circuit)",
      referencesEvaluated: 0,
      retractedDoisText: ""
    };
  }
  // --- END fast path ---

  // 1) Get focal work from OpenAlex by DOI
  var workUrl =
    "https://api.openalex.org/works/https://doi.org/" +
    encodeURIComponent(doi);

  if (OPENALEX_MAILTO) {
    workUrl += (workUrl.indexOf("?") === -1 ? "?" : "&") +
      "mailto=" +
      encodeURIComponent(OPENALEX_MAILTO);
  }

  var frWork = fetchWithRetry_(
    workUrl,
    { muteHttpExceptions: true },
    "OpenAlex work"
  );

  if (frWork.error) {
    return {
      statusLabel: "ERROR",
      reason: frWork.error,
      referencesEvaluated: "",
      retractedDoisText: ""
    };
  }

  var respWork = frWork.response;
  var codeWork = respWork.getResponseCode();

  if (codeWork === 404) {
    return {
      statusLabel: "UNKNOWN",
      reason: "OpenAlex: DOI not found",
      referencesEvaluated: "",
      retractedDoisText: ""
    };
  }

  if (codeWork !== 200) {
    return {
      statusLabel: "ERROR",
      reason: "OpenAlex work HTTP " + codeWork,
      referencesEvaluated: "",
      retractedDoisText: ""
    };
  }

  var jsonWork;
  try {
    jsonWork = JSON.parse(respWork.getContentText());
  } catch (e) {
    return {
      statusLabel: "ERROR",
      reason: "OpenAlex work invalid JSON",
      referencesEvaluated: "",
      retractedDoisText: ""
    };
  }

  if (!jsonWork || typeof jsonWork !== "object") {
    return {
      statusLabel: "UNKNOWN",
      reason: "OpenAlex work: empty payload",
      referencesEvaluated: "",
      retractedDoisText: ""
    };
  }

  var selfRetracted = !!jsonWork.is_retracted;
  var selfNote = selfRetracted ? "Self: retracted (OpenAlex)" : "Self: not retracted (OpenAlex)";

  var refIds = jsonWork.referenced_works;
  if (!refIds || !refIds.length) {
    // If the article itself is retracted, that should dominate the status,
    // even if there are no references.
    var statusLabelNoRefs = selfRetracted ? "RETRACTED" : "NO REFERENCES FOUND";
    return {
      statusLabel: statusLabelNoRefs,
      reason: selfNote + " | OpenAlex: 0 references",
      referencesEvaluated: 0,
      retractedDoisText: ""
    };
  }

  // 2) Fetch metadata for referenced works in batches (by OpenAlex ID)
  var evaluated = 0;
  var retractedCount = 0;
  var viaRW = 0;
  var viaOA = 0;
  var retractedDois = [];

  var batchSizeRefs = 40; // how many OpenAlex IDs per request
  for (var start = 0; start < refIds.length; start += batchSizeRefs) {
    var slice = refIds.slice(start, start + batchSizeRefs);

    // Extract W IDs (last segment)
    var idList = [];
    for (var j = 0; j < slice.length; j++) {
      var full = slice[j];
      if (!full) {
        continue;
      }
      var parts = String(full).split("/");
      var wid = parts[parts.length - 1];
      if (wid) {
        idList.push(wid);
      }
    }

    if (idList.length === 0) {
      continue;
    }

    var filterValue = encodeURIComponent(idList.join("|"));
    var refsUrl =
      "https://api.openalex.org/works?filter=openalex:" +
      filterValue +
      "&per-page=200&select=id,doi,is_retracted";

    if (OPENALEX_MAILTO) {
      refsUrl += "&mailto=" + encodeURIComponent(OPENALEX_MAILTO);
    }

    var frRefs = fetchWithRetry_(
      refsUrl,
      { muteHttpExceptions: true },
      "OpenAlex references"
    );
    if (frRefs.error) {
      // If references fetch fails, we still report what we have so far
      return {
        statusLabel: "ERROR",
        reason: selfNote + " | " + frRefs.error,
        referencesEvaluated: evaluated,
        retractedDoisText: retractedDois.join(", ")
      };
    }

    var respRefs = frRefs.response;
    var codeRefs = respRefs.getResponseCode();
    if (codeRefs !== 200) {
      return {
        statusLabel: "ERROR",
        reason: selfNote + " | OpenAlex refs HTTP " + codeRefs,
        referencesEvaluated: evaluated,
        retractedDoisText: retractedDois.join(", ")
      };
    }

    var jsonRefs;
    try {
      jsonRefs = JSON.parse(respRefs.getContentText());
    } catch (e2) {
      return {
        statusLabel: "ERROR",
        reason: selfNote + " | OpenAlex refs invalid JSON",
        referencesEvaluated: evaluated,
        retractedDoisText: retractedDois.join(", ")
      };
    }

    if (!jsonRefs || !jsonRefs.results) {
      continue;
    }

    var results = jsonRefs.results;
    for (var k = 0; k < results.length; k++) {
      var refWork = results[k];
      if (!refWork) {
        continue;
      }
      evaluated++;

      var refDoi = refWork.doi;
      var refRetractedOA = !!refWork.is_retracted;
      var refRetractedRW = false;

      if (refDoi && rwCache && rwCache.map) {
        var norm = normalizeDoi_(refDoi);
        if (norm && rwCache.map[norm]) {
          refRetractedRW = true;
        }
      }

      if (refRetractedOA || refRetractedRW) {
        retractedCount++;
        if (refRetractedOA) {
          viaOA++;
        }
        if (refRetractedRW) {
          viaRW++;
        }
        if (refDoi) {
          // Store normalized DOI for human inspection
          var normRef = normalizeDoi_(refDoi);
          if (normRef) {
            retractedDois.push(normRef);
          }
        }
      }
    }
  }

  // Deduplicate retractedDois
  var retractedDoisText = "";
  if (retractedDois.length > 0) {
    var uniqMap = {};
    var uniqList = [];
    for (var u = 0; u < retractedDois.length; u++) {
      var d = retractedDois[u];
      if (!uniqMap[d]) {
        uniqMap[d] = true;
        uniqList.push(d);
      }
    }
    retractedDoisText = uniqList.join(", ");
  }

  // 3) Decide status
  if (evaluated === 0) {
    // If self is retracted, that has priority.
    var statusLabelNoEval = selfRetracted ? "RETRACTED" : "NO REFERENCES FOUND";
    return {
      statusLabel: statusLabelNoEval,
      reason: selfNote + " | OpenAlex: references not resolved",
      referencesEvaluated: 0,
      retractedDoisText: retractedDoisText
    };
  }

  var statusLabel;
  if (selfRetracted) {
    // Self-retraction dominates
    statusLabel = "RETRACTED";
  } else if (retractedCount > 0) {
    statusLabel = "CITES RETRACTED";
  } else {
    statusLabel = "NO RETRACTED CITATIONS FOUND";
  }

  var bits = [];
  bits.push(selfNote);
  bits.push("References: " + retractedCount + "/" + evaluated + " flagged");

  if (viaRW > 0) {
    bits.push("via RW index: " + viaRW);
  }
  if (viaOA > 0) {
    bits.push("via OpenAlex: " + viaOA);
  }
  if (!rwCache || rwCache.error) {
    bits.push("RW index unavailable – only OpenAlex used for flags");
  }

  return {
    statusLabel: statusLabel,
    reason: bits.join(" | "),
    referencesEvaluated: evaluated,
    retractedDoisText: retractedDoisText
  };
}

// ===== Retraction Watch DOI index loader =====
function getRetractionWatchCache_() {
  if (RW_CACHE !== null) {
    return RW_CACHE;
  }

  try {
    var resp = UrlFetchApp.fetch(
      RETRACTION_WATCH_INDEX_URL,
      { muteHttpExceptions: true }
    );
    var code = resp.getResponseCode();
    if (code !== 200) {
      RW_CACHE = {
        error: "RW index HTTP " + code,
        map: null
      };
      return RW_CACHE;
    }

    var text = resp.getContentText();
    if (!text) {
      RW_CACHE = {
        error: "RW index empty",
        map: null
      };
      return RW_CACHE;
    }

    // Assume one DOI per line (possibly with some blank lines)
    var lines = text.split(/\r?\n/);
    var map = {};
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) {
        continue;
      }
      var norm = normalizeDoi_(line);
      if (!norm) {
        continue;
      }
      map[norm] = true;
    }

    RW_CACHE = { error: null, map: map };
    return RW_CACHE;
  } catch (e) {
    RW_CACHE = {
      error: "RW index exception: " + e,
      map: null
    };
    return RW_CACHE;
  }
}

// ===== Helpers =====
function normalizeDoi_(doi) {
  if (!doi) {
    return "";
  }
  var s = String(doi).trim();
  s = s.replace(/^https?:\/\/doi\.org\//i, "");
  s = s.replace(/^doi:/i, "");
  return s.toLowerCase();
}

// Generic fetch with retry + backoff (handles 429)
function fetchWithRetry_(url, options, label) {
  var maxRetries = 2;
  var delayMs = 3000;

  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    var resp;
    try {
      resp = UrlFetchApp.fetch(url, options);
    } catch (e) {
      if (attempt === maxRetries) {
        return { error: label + " network error: " + e };
      }
      Utilities.sleep(delayMs);
      delayMs *= 2;
      continue;
    }

    var code = resp.getResponseCode();
    if (code === 429) {
      if (attempt === maxRetries) {
        return { error: label + " HTTP 429 (rate limited)" };
      }
      Utilities.sleep(delayMs);
      delayMs *= 2;
      continue;
    }

    return { response: resp };
  }

  return { error: label + " unknown fetch failure" };
}
