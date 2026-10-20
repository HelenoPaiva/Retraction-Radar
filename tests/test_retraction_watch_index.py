import csv
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.build_retraction_watch_index import build_index, read_dois


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / "input.csv"
        self.destination = Path(self.directory.name) / "index.txt"

    def write_csv(self, rows, encoding="utf-8", header=("Title", "OriginalPaperDOI")):
        text = io.StringIO(newline="")
        writer = csv.writer(text)
        writer.writerow(header)
        writer.writerows(rows)
        self.source.write_bytes(text.getvalue().encode(encoding))

    def assert_rejected_without_replacing(self, data):
        self.source.write_bytes(data)
        original = b"10.1234/previous\n"
        self.destination.write_bytes(original)
        with self.assertRaises((ValueError, csv.Error)):
            build_index(self.source, self.destination)
        self.assertEqual(self.destination.read_bytes(), original)
        self.assertFalse(list(self.destination.parent.glob("*.tmp")))

    def test_normalize_deduplicate_and_sort(self):
        self.write_csv([
            ("A", " HTTPS://DX.DOI.ORG/10.1234/B "),
            ("B", "doi:10.1234/A"),
            ("C", "10.1234/b"),
            ("D", "unavailable"),
            ("E", "10.1234/has space"),
        ])
        self.assertEqual(build_index(self.source, self.destination), (2, 5))
        self.assertEqual(self.destination.read_bytes(), b"10.1234/a\n10.1234/b\n")

    def test_utf8_bom_and_nonascii_metadata(self):
        self.write_csv([("α and café", "10.1234/A")], encoding="utf-8-sig")
        self.assertEqual(read_dois(self.source), ({"10.1234/a"}, 1))

    def test_cp1252_metadata(self):
        self.write_csv([("Ji’an, España", "10.1234/a")], encoding="cp1252")
        self.assertEqual(read_dois(self.source), ({"10.1234/a"}, 1))

    def test_mixed_encodings_and_undefined_cp1252_byte(self):
        data = b'Title,OriginalPaperDOI\n"Ji\x92an, \x81 and ' + "α".encode() + b'",10.1234/a\n'
        self.source.write_bytes(data)
        self.assertEqual(read_dois(self.source), ({"10.1234/a"}, 1))
        self.assertEqual(self.source.read_bytes(), data)

    def test_failure_after_first_decoder_buffer(self):
        # The production error was position 1094 in the third 8192-byte buffer.
        data = b'Title,OriginalPaperDOI\n"' + b'x' * 17456 + b'\x92",10.1234/a\n'
        self.source.write_bytes(data)
        self.assertEqual(read_dois(self.source), ({"10.1234/a"}, 1))

    def test_quoted_commas_newlines_and_crlf(self):
        self.write_csv([('First, "second"\nthird', "10.1234/a")])
        self.assertEqual(read_dois(self.source), ({"10.1234/a"}, 1))

    def test_doi_alias_and_original_precedence(self):
        self.write_csv([("", "10.1234/fallback"), ("10.1234/original", "10.1234/ignored")],
                       header=("originalpaperdoi", "DOI"))
        self.assertEqual(read_dois(self.source), ({"10.1234/fallback", "10.1234/original"}, 2))

    def test_valid_unicode_doi_is_not_mojibake(self):
        self.write_csv([("Title", "10.1234/É")])
        build_index(self.source, self.destination)
        self.assertEqual(self.destination.read_text(), "10.1234/é\n")

    def test_invalid_doi_encoding_is_not_replaced_or_dropped(self):
        self.assert_rejected_without_replacing(b"Title,OriginalPaperDOI\nA,10.1234/bad\x92\n")

    def test_late_failure_does_not_publish_partial_results(self):
        for last_row in (b"B,10.1234/bad\x92\n", b'"unfinished,10.1234/b\n'):
            with self.subTest(last_row=last_row):
                self.assert_rejected_without_replacing(
                    b"Title,DOI\nA,10.1234/previous\n" + last_row
                )

    def test_control_character_in_doi(self):
        self.assert_rejected_without_replacing(b'Title,OriginalPaperDOI\nA,"10.1234/a\nb"\n')

    def test_empty_input_and_no_usable_dois(self):
        for data in (b"", b"Title,DOI\n", b"Title,DOI\nA,unavailable\n"):
            with self.subTest(data=data):
                self.assert_rejected_without_replacing(data)

    def test_missing_duplicate_and_invalid_headers(self):
        for data in (b"<html>upstream error</html>\n", b"Title,URL\nA,10.1234/a\n",
                     b"DOI,doi\n10.1234/a,10.1234/b\n", b"\xffTitle,DOI\nA,10.1234/a\n"):
            with self.subTest(data=data):
                self.assert_rejected_without_replacing(data)

    def test_malformed_or_truncated_records(self):
        for data in (b'Title,DOI\n"unfinished,10.1234/a\n',
                     b"Title,DOI\nA,10.1234/a,extra\n", b"Title,DOI\nA\n",
                     b"Title,DOI\nA\x00,10.1234/a\n"):
            with self.subTest(data=data):
                self.assert_rejected_without_replacing(data)

    def test_large_loss_preserves_previous_index(self):
        self.write_csv([("A", "10.1234/a")])
        original = "".join(f"10.1234/{i}\n" for i in range(100))
        self.destination.write_text(original)
        with self.assertRaisesRegex(ValueError, "5%"):
            build_index(self.source, self.destination)
        self.assertEqual(self.destination.read_text(), original)

    def test_small_source_corrections_are_allowed(self):
        self.destination.write_text("".join(f"10.1234/{i}\n" for i in range(100)))
        self.write_csv([("A", f"10.1234/{i}") for i in range(95)])
        self.assertEqual(build_index(self.source, self.destination), (95, 95))

    def test_new_dois_do_not_mask_large_loss_of_old_dois(self):
        original = "".join(f"10.1234/{i}\n" for i in range(100))
        self.destination.write_text(original)
        self.write_csv([("A", f"10.1234/{i}") for i in range(10, 120)])
        with self.assertRaisesRegex(ValueError, "5%"):
            build_index(self.source, self.destination)
        self.assertEqual(self.destination.read_text(), original)

    def test_replace_failure_preserves_previous_index_and_cleans_temporary_file(self):
        original = b"10.1234/a\n"
        self.destination.write_bytes(original)
        self.write_csv([("A", "10.1234/a"), ("B", "10.1234/b")])
        with patch("scripts.build_retraction_watch_index.os.replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                build_index(self.source, self.destination)
        self.assertEqual(self.destination.read_bytes(), original)
        self.assertEqual(sorted(p.name for p in self.destination.parent.iterdir()), ["index.txt", "input.csv"])

    def test_fsync_failure_preserves_previous_index(self):
        original = b"10.1234/a\n"
        self.destination.write_bytes(original)
        self.write_csv([("A", "10.1234/a")])
        with patch("scripts.build_retraction_watch_index.os.fsync", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                build_index(self.source, self.destination)
        self.assertEqual(self.destination.read_bytes(), original)
        self.assertEqual(sorted(p.name for p in self.destination.parent.iterdir()), ["index.txt", "input.csv"])


if __name__ == "__main__":
    unittest.main()
