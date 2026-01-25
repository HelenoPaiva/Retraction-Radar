[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.18369379.svg)](https://doi.org/10.5281/zenodo.18369379)
[![GitHub Pages](https://img.shields.io/badge/live-GitHub%20Pages-brightgreen)](https://helenopaiva.github.io/Retraction-Radar/)
[![GitHub release](https://img.shields.io/github/v/release/HelenoPaiva/Retraction-Radar)](https://github.com/HelenoPaiva/Retraction-Radar/releases/tag/v1.0.0)
![Last commit](https://img.shields.io/github/last-commit/HelenoPaiva/Retraction-Radar)


# Retraction Radar

A lightweight, reproducible tool to check whether papers **cited by an article**
(e.g. a systematic review or meta-analysis) have been **retracted**, **corrected**
or flagged with an **expression of concern**.

**Live website:**  
https://helenopaiva.github.io/Retraction-Radar/

---

## What it does

Given a DOI (or DOI URL), Retraction Radar:

1. Resolves the article in **OpenAlex** and retrieves its reference list.
2. Fetches metadata for each cited work.
3. Checks cited records against **Crossref** update metadata and the
   **Retraction Watch** database.
4. Displays an interactive table with filters and status flags.
5. Allows exporting the full results as a **CSV file**.

The goal is to rapidly identify references that warrant **manual review**.

---

## Why this exists

Systematic reviews and meta-analyses can become unreliable when included studies
are later retracted or substantially corrected. There is no simple, unified way
to periodically screen reference lists for these events.

Retraction Radar provides a fast and transparent way to:
- Scan an article’s references for potential integrity issues
- Document findings via CSV export
- Support editorial, reviewer, and author re-evaluation

It does **not** replace critical appraisal or editorial judgment.

---

## How to use the Retraction Radar webpage

1. Open the live site:  
   https://helenopaiva.github.io/Retraction-Radar/
2. Paste a DOI or DOI URL.
3. Click **Analyze**.
4. Review flagged references using the interactive table.
5. Export the results as a CSV if needed.

The webpage is a static, client-side tool (no backend).  
Results reflect the metadata available at the time of analysis.

---

## How to use the Google Sheets script (`code.gs`)

The repository includes a Google Sheets script (`code.gs`) designed to work with
large citation datasets inside **Google Sheets**, integrating multiple scholarly
data sources.

### Workflow

1. Run a literature search (e.g. PubMed or similar).
2. Export the **entire search result** as a **CSV** file.
3. Upload the CSV to **Google Sheets**.
4. In Google Sheets, open:  
   `Extensions → Apps Script`
5. Paste the contents of `code.gs` into the editor and save.
6. Run the main function and authorize the script when prompted.
7. The script will retrieve and reconcile metadata from:
   - OpenAlex
   - Crossref
   - Retraction Watch  
   and populate structured tables in the spreadsheet.

This workflow is intended for:
- Large or repeated searches
- Metadata normalization
- Offline or auditable citation screening

Authorization is required only on first use.

---

## Data sources

- **OpenAlex** – reference lists and general scholarly metadata  
- **Crossref** – update metadata (retractions, corrections, withdrawals)  
- **Retraction Watch** – curated database of retracted and problematic publications  

---

## Limitations

- Dependent on the completeness and accuracy of external metadata sources.
- References without stable identifiers may not be fully resolved.
- Results represent a **single point in time**; periodic re-checking is recommended.

---

## Author

Developed and maintained by  
**Heleno de Paiva Oliveira, MD, PhD**  
Professor of Anesthesiology  
Universidade Federal do Rio Grande do Norte (UFRN)
