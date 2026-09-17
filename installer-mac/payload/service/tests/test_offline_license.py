from pathlib import Path
from tempfile import TemporaryDirectory
import json
import time
import unittest
from unittest.mock import patch

from admin.license_admin import ensure_keys, generate_code
from service.offline_license import (
    OfflineLicenseError,
    activate_code,
    current_status,
)


class OfflineLicenseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ensure_keys()

    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.state_file = Path(self.temporary.name) / "license.json"
        self.state_patch = patch(
            "service.offline_license.STATE_FILE", self.state_file
        )
        self.first_run_file = Path(self.temporary.name) / "first-run.json"
        self.first_run_patch = patch(
            "service.offline_license.FIRST_RUN_FILE", self.first_run_file
        )
        self.state_patch.start()
        self.first_run_patch.start()

    def tearDown(self):
        self.state_patch.stop()
        self.first_run_patch.stop()
        self.temporary.cleanup()

    def test_signed_license_activates_and_persists(self):
        code, _ = generate_code("Cliente prueba", 3, "device-0001")
        activated = activate_code(code, "device-0001")
        self.assertTrue(activated["active"])
        self.assertTrue(activated["deviceBound"])
        self.assertGreaterEqual(activated["daysRemaining"], 89)
        self.assertTrue(current_status("device-0001")["active"])

    def test_device_bound_code_rejects_other_device(self):
        code, _ = generate_code("Cliente prueba", 3, "device-0001")
        with self.assertRaises(OfflineLicenseError):
            activate_code(code, "device-0002")

    def test_modified_code_is_rejected(self):
        code, _ = generate_code("Cliente prueba", 3, "")
        modified = code[:-2] + ("AA" if code[-2:] != "AA" else "BB")
        with self.assertRaises(OfflineLicenseError):
            activate_code(modified, "device-0001")

    def test_friendly_prefix_is_accepted(self):
        code, _ = generate_code("Cliente prueba", 3, "")
        activated = activate_code(
            f"gota3mesesgratis-{code}", "device-0001"
        )
        self.assertTrue(activated["active"])

    def test_clock_rollback_is_detected(self):
        code, _ = generate_code("Cliente prueba", 3, "")
        activate_code(code, "device-0001")
        state = json.loads(self.state_file.read_text(encoding="utf-8"))
        state["lastSeenAt"] = int(time.time()) + 3600
        self.state_file.write_text(json.dumps(state), encoding="utf-8")
        with self.assertRaises(OfflineLicenseError):
            current_status("device-0001")

    def test_first_run_receives_seven_day_grace(self):
        status = current_status("device-0001")
        self.assertTrue(status["active"])
        self.assertTrue(status["grace"])
        self.assertEqual(status["daysRemaining"], 7)

    def test_perpetual_license_has_no_expiry(self):
        code, _ = generate_code(
            "Licencia interna", 1, "device-0001", perpetual=True
        )
        status = activate_code(code, "device-0001")
        self.assertTrue(status["active"])
        self.assertTrue(status["perpetual"])
        self.assertIsNone(status["expiresAt"])
        self.assertIsNone(status["daysRemaining"])


if __name__ == "__main__":
    unittest.main()
