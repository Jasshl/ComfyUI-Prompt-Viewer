import tempfile
import unittest
from pathlib import Path

from path_utils import bounded_int, safe_output_path


class SafeOutputPathTests(unittest.TestCase):
    def test_allows_nested_output_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = root / "project" / "image.png"
            self.assertEqual(
                safe_output_path(root, "project", "image.png"),
                expected.resolve(),
            )

    def test_rejects_parent_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                safe_output_path(directory, "../private", "image.png")

    def test_rejects_filename_with_path_components(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                safe_output_path(directory, "", "nested/image.png")

    def test_rejects_symlink_that_escapes_output(self):
        with tempfile.TemporaryDirectory() as output, tempfile.TemporaryDirectory() as outside:
            link = Path(output) / "outside"
            try:
                link.symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("Symlinks are unavailable")
            with self.assertRaises(ValueError):
                safe_output_path(output, "outside", "image.png")


class BoundedIntTests(unittest.TestCase):
    def test_clamps_and_defaults(self):
        self.assertEqual(bounded_int("50", 10, 1, 20), 20)
        self.assertEqual(bounded_int("-2", 10, 1, 20), 1)
        self.assertEqual(bounded_int("invalid", 10, 1, 20), 10)


if __name__ == "__main__":
    unittest.main()
