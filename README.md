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
2. Fetches metadata for each cited work (title, year, DOI).
3. Checks each DOI in **Crossref** for update signals (retractions, corrections,
   expressions of concern, withdrawals).
4. Displays an interactive table with:
   - Status labels
   - Filtering pills (Total, Retracted, No DOI, Unknown, etc.)
5. Allows exporting the full results as a **CSV file**.

The goal is to quickly identify references that warrant **manual review**.

---

## Why this exists

Meta-analyses and systematic reviews can become unreliable when included studies
are later retracted or seriously corrected. There is no simple, unified way to
periodically screen reference lists for these events.

Retraction Radar provides a fast, transparent way to:
- Scan an article’s references for potential problems
- Document findings via CSV export
- Support editorial, reviewer, and author re-evaluation

It does **not** replace critical appraisal or editorial judgement.

---

## How to use

1. Open the live site:  
   https://helenopaiva.github.io/Retraction-Radar/
2. Paste a DOI or DOI URL.
3. Click **Analyze**.
4. Review flagged references and export results if needed.

---

## Data sources (brief)

- **OpenAlex** – reference lists and basic metadata  
- **Crossref** – update metadata (retractions, corrections, expressions of concern)

Each cited paper is classified as:
**OK**, **Retracted**, **Expression of concern**, **Corrected / Erratum**,
**Withdrawn**, **No DOI**, or **Unknown**.

---

## Limitations

- Depends on OpenAlex and Crossref metadata accuracy.
- References without DOIs cannot be checked in Crossref.
- Results reflect a **single point in time**; re-checking is recommended.

---

## Local use

This is a static site (no backend).  
Clone the repository and open `index.html` in a browser.

---

## Author

Developed and maintained by  
**Heleno de Paiva Oliveira, MD, PhD**  
Anesthesiology Professor  
Universidade Federal do Rio Grande do Norte (UFRN)
