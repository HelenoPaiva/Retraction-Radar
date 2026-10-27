#!/usr/bin/env python3
"""Build a validated DOI index without guessing the encoding of unused metadata."""

import argparse
import csv
import os
from pathlib import Path
import re
import tempfile


def normalize_doi(value: str) -> str:
    value = value.strip()
    value = re.sub(r"^https?://(dx\.)?doi\.org/", "", value, flags=re.I)
    value = re.sub(r"^doi:", "", value, flags=re.I)
    return value.lower()


def read_dois(source: Path) -> tuple[set[str], int]:
    dois = set()
    rows = 0
    # The upstream export can mix UTF-8 and Windows-1252 in descriptive fields.
    # surrogateescape preserves undecodable bytes, rather than replacing/dropping
    # them or incorrectly interpreting the entire file as a single legacy codec.
    # CSV delimiters are ASCII. Only DOI values leave this parser, and those must
    # encode strictly as UTF-8 before normalization or publication.
    with source.open(encoding="utf-8-sig", errors="surrogateescape", newline="") as stream:
        reader = csv.reader(stream, strict=True)
        headers = next(reader, [])
        if not headers or any(not name.isascii() for name in headers):
            raise ValueError("Missing or invalid CSV header")
        # The October 2026 upstream export adds one empty terminal field.
        # Accept it only as padding: never discard an unnamed data column.
        expected_width = len(headers)
        trailing_padding = headers[-1] == ""
        if trailing_padding:
            headers = headers[:-1]
        headers = [name.strip().lower() for name in headers]
        if not headers or len(headers) != len(set(headers)) or any(not name for name in headers):
            raise ValueError("Empty or duplicate CSV columns")
        doi_columns = [headers.index(name) for name in ("originalpaperdoi", "doi") if name in headers]
        if not doi_columns:
            raise ValueError("CSV is missing the OriginalPaperDOI/DOI column")

        for row in reader:
            if not row:  # csv.DictReader also skips empty physical lines.
                continue
            rows += 1
            if len(row) != expected_width:
                raise ValueError(f"Wrong column count at CSV line {reader.line_num}")
            if any("\x00" in value for value in row):
                raise ValueError(f"NUL byte at CSV line {reader.line_num}")
            if trailing_padding and row[-1] != "":
                raise ValueError(f"Nonempty unnamed trailing column at CSV line {reader.line_num}")
            values = [row[column] for column in doi_columns]
            for value in values:
                try:
                    value.encode("utf-8", errors="strict")
                except UnicodeEncodeError as exc:
                    raise ValueError(f"Undecodable DOI at CSV line {reader.line_num}") from exc
                if any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value):
                    raise ValueError(f"Control character in DOI at CSV line {reader.line_num}")
            value = next((value for value in values if value), "")
            doi = normalize_doi(value)
            # Preserve the existing DOI filter, but reject all embedded whitespace.
            if doi.startswith("10.") and not any(char.isspace() for char in doi):
                dois.add(doi)

    if not rows or not dois:
        raise ValueError("CSV contains no usable DOIs; keeping the previous index")
    return dois, rows


def build_index(source: Path, destination: Path) -> tuple[int, int]:
    dois, rows = read_dois(source)
    if destination.exists():
        previous = set(destination.read_text(encoding="utf-8").splitlines())
        # A syntactically valid but truncated download must not erase the index.
        # Allow normal source corrections, but require investigation for large loss.
        if previous and len(previous - dois) / len(previous) > 0.05:
            raise ValueError("More than 5% of existing DOIs would disappear; keeping the previous index")

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=destination.parent,
            prefix=f".{destination.name}.", suffix=".tmp", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            for doi in sorted(dois):
                stream.write(doi + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return len(dois), rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    count, rows = build_index(args.source, args.destination)
    print(f"Validated {rows} CSV records; wrote {count} DOIs to {args.destination}")


if __name__ == "__main__":
    main()
