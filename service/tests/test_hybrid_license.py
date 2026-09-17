import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from service import hybrid_license


class HybridLicenseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.state_file = root / "cloud-state.json"
        self.config_file = root / "cloud-config.json"
        self.config_file.write_text(
            '{"apiUrl":"https://licenses.example.test"}',
            encoding="utf-8",
        )
        self.patches = [
            patch.object(
                hybrid_license, "CLOUD_STATE_FILE", self.state_file
            ),
            patch.object(
                hybrid_license, "CLOUD_CONFIG_FILE", self.config_file
            ),
        ]
        for active_patch in self.patches:
            active_patch.start()

    def tearDown(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()
        self.temporary.cleanup()

    def test_short_code_activation_is_cached_without_exposing_token(self):
        remote = {
            "active": True,
            "licenseId": "8",
            "label": "Cliente",
            "perpetual": True,
            "activationToken": "secret-token",
            "offlineToleranceHours": 72,
        }
        with patch.object(
            hybrid_license, "_cloud_call", return_value=remote
        ):
            result = hybrid_license.activate_license(
                "gota3meses", "device-12345678"
            )
        self.assertTrue(result["active"])
        self.assertNotIn("activationToken", result)
        self.assertIn("secret-token", self.state_file.read_text())

    def test_network_failure_uses_recent_cached_license(self):
        hybrid_license._save_cloud_state(
            {
                "active": True,
                "licenseId": "9",
                "label": "Indefinida",
                "perpetual": True,
                "activationToken": "cached-token",
                "offlineToleranceHours": 72,
            },
            "device-12345678",
        )
        with patch.object(
            hybrid_license,
            "_cloud_call",
            side_effect=hybrid_license.OfflineLicenseError(
                "No se pudo conectar al servidor de licencias."
            ),
        ):
            result = hybrid_license.current_license_status(
                "device-12345678"
            )
        self.assertTrue(result["active"])
        self.assertTrue(result["offline"])


if __name__ == "__main__":
    unittest.main()
