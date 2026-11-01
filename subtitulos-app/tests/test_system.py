import tempfile
import unittest
from pathlib import Path
from unittest import mock

from gota_subtitulos import system


class ExportFolderTests(unittest.TestCase):
    def test_chosen_folder_is_remembered_and_reset(self):
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as chosen, \
                tempfile.TemporaryDirectory() as default:
            with mock.patch.object(system, "data_dir", return_value=Path(data)), \
                    mock.patch.object(system, "default_export_dir", return_value=Path(default)):
                self.assertEqual(system.export_dir(), Path(default))
                system.set_export_dir(chosen)
                self.assertTrue(system.same_folder(system.export_dir(), chosen))
                system.set_export_dir(None)
                self.assertEqual(system.export_dir(), Path(default))

    def test_missing_chosen_folder_falls_back(self):
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as default:
            with mock.patch.object(system, "data_dir", return_value=Path(data)), \
                    mock.patch.object(system, "default_export_dir", return_value=Path(default)):
                system.set_export_dir(str(Path(data) / "ya-no-existe"))
                self.assertEqual(system.export_dir(), Path(default))


if __name__ == "__main__":
    unittest.main()
