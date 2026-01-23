// Retraction Radar – "Does this paper cite retracted literature?"
// DOIs in column K
// Output in L (status), M (reason), N (references evaluated)

// =========== CONFIG ===========
var COL_DOI = 11;       // K
var COL_STATUS = 12;    // L
var COL_REASON = 13;    // M
var COL_REFS = 14;      // N: number of references evaluated

var HEADER_ROW = 1;

// Be gentle with APIs
var BATCH_SIZE = 10;
var MAX_RUNTIME_MS = 5 * 60 * 1000; // 5 minutes
var PER_DOI_SLEEP_MS = 1000;        // 1 second between DOIs

// =========== MENU ===========
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Retraction Radar")
    .addItem("Process next batch (" + BATCH_SIZE + ")", "processNextBatch")
    .addItem("Process ALL remaining", "processAllRemaining")
    .addSeparator()
    .addItem("Reset results (L-N)", "resetResults")
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
  var numCols = COL_REFS - COL_STATUS + 1;
  sh.getRange(HEADER_ROW + 1, COL_STATUS, numRows, numCols).clearContent();
}

// =========== CORE BATCH LOOP ===========
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
  var numCols = COL_REFS;
  var data = sh.getRange(HEADER_ROW + 1, 1, numRows, numCols).getValues();

  var startTime = Date.now();
  var processed = 0;

  for (var i = 0; i < data.length; i++) {
    var rowIndex = HEADER_ROW + 1 + i;
    var row = data[i];

    var doi = row[COL_DOI - 1];
    var status = row[COL_STATUS - 1];

    // Skip if no DOI or already processed
    if (!doi || String(doi).trim() === "" || status) {
      continue;
    }

    // Stop early to avoid hitting 6 min limit (20s margin)
    if (Date.now() - startTime > MAX_RUNTIME_MS - 20000) {
      break;
    }

    var result = checkReferencesForDoi_(String(doi).trim());

    sh.getRange(rowIndex, COL_STATUS, 1, 3).setValues([[
      result.statusLabel,
      result.reason,
      result.referencesEvaluated
    ]]);

    processed++;
    // gentle delay to avoid hammering OpenAlex
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

// =========== CORE LOGIC: does this paper CITE retracted literature? ===========
/**
 * For a given DOI:
 *  1) Look up the work in OpenAlex
 *  2) Get all works it cites (outgoing references) via filter=cited_by:WID
 *  3) Check each referenced work's is_retracted flag
 *  4) Return status + how many references were evaluated
 */
function checkReferencesForDoi_(doi) {
  // 1) Look up the work by DOI
  var workUrl = "https://api.openalex.org/works/https://doi.org/" + encodeURIComponent(doi);
  var frWork = fetchWithRetry_(workUrl, { muteHttpExceptions: true }, "OpenAlex work");
  if (frWork.error) {
    return {
      statusLabel: "ERROR",
      reason: frWork.error,
      referencesEvaluated: ""
    };
  }

  var respWork = frWork.response;
  var codeWork = respWork.getResponseCode();
  if (codeWork === 404) {
    return {
      statusLabel: "UNKNOWN",
      reason: "OpenAlex: DOI not found",
      referencesEvaluated: ""
    };
  }
  if (codeWork !== 200) {
    return {
      statusLabel: "ERROR",
      reason: "OpenAlex work HTTP " + codeWork,
      referencesEvaluated: ""
    };
  }

  var jsonWork;
  try {
    jsonWork = JSON.parse(respWork.getContentText());
  } catch (e) {
    return {
      statusLabel: "ERROR",
      reason: "OpenAlex work invalid JSON",
      referencesEvaluated: ""
    };
  }

  if (!jsonWork || typeof jsonWork !== "object") {
    return {
      statusLabel: "UNKNOWN",
      reason: "OpenAlex work: empty payload",
      referencesEvaluated: ""
    };
  }

  // self retraction status (for context)
  var selfRetracted = !!jsonWork.is_retracted;
  var selfNote = selfRetracted ? "Self: retracted" : "Self: not retracted";

  var workIdFull = jsonWork.id || "";
  if (!workIdFull) {
    return {
      statusLabel: "UNKNOWN",
      reason: selfNote + " | OpenAlex: no work ID",
      referencesEvaluated: ""
    };
  }

  // workId is the Wxxxxxxx part
  var parts = workIdFull.split("/");
  var workId = parts[parts.length - 1]; // e.g. W2766808518

  // 2) Get all cited works via filter=cited_by:WID
  var refsUrl =
    "https://api.openalex.org/works?filter=cited_by:" +
    encodeURIComponent(workId) +
    "&per-page=200";

  var frRefs = fetchWithRetry_(refsUrl, { muteHttpExceptions: true }, "OpenAlex references");
  if (frRefs.error) {
    return {
      statusLabel: "ERROR",
      reason: selfNote + " | " + frRefs.error,
      referencesEvaluated: ""
    };
  }

  var respRefs = frRefs.response;
  var codeRefs = respRefs.getResponseCode();
  if (codeRefs !== 200) {
    return {
      statusLabel: "ERROR",
      reason: selfNote + " | OpenAlex refs HTTP " + codeRefs,
      referencesEvaluated: ""
    };
  }

  var jsonRefs;
  try {
    jsonRefs = JSON.parse(respRefs.getContentText());
  } catch (e2) {
    return {
      statusLabel: "ERROR",
      reason: selfNote + " | OpenAlex refs invalid JSON",
      referencesEvaluated: ""
    };
  }

  if (!jsonRefs || !jsonRefs.results) {
    return {
      statusLabel: "NO REFERENCES FOUND",
      reason: selfNote + " | OpenAlex: no references in results",
      referencesEvaluated: 0
    };
  }

  var results = jsonRefs.results;
  var totalRefs = results.length;

  if (totalRefs === 0) {
    return {
      statusLabel: "NO REFERENCES FOUND",
      reason: selfNote + " | OpenAlex: 0 references",
      referencesEvaluated: 0
    };
  }

  // 3) Count retracted references
  var retractedCount = 0;
  for (var i = 0; i < results.length; i++) {
    var refWork = results[i];
    if (refWork && refWork.is_retracted) {
      retractedCount++;
    }
  }

  // 4) Decide status
  var statusLabel;
  var refNote = "References: " + retractedCount + "/" + totalRefs + " retracted (OpenAlex)";

  if (retractedCount > 0) {
    statusLabel = "CITES RETRACTED";
  } else {
    statusLabel = "NO RETRACTED CITATIONS FOUND";
  }

  // Note: we treat "no refs" separately above as NO REFERENCES FOUND

  return {
    statusLabel: statusLabel,
    reason: selfNote + " | " + refNote,
    referencesEvaluated: totalRefs
  };
}

// =========== FETCH WITH RETRY / BACKOFF ===========
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
