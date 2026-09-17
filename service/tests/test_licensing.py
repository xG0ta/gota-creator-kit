from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from service.licensing import LicenseError, LicenseStore


class LicenseStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.store = LicenseStore(Path(self.temporary.name) / "licenses.sqlite3")

    def tearDown(self):
        self.temporary.cleanup()

    def test_register_starts_trial_and_login_works(self):
        token, account = self.store.register(
            "editor@example.com", "password123", "device-0001", "Estudio"
        )
        self.assertTrue(account["authenticated"])
        self.assertEqual(account["status"], "trial")
        self.assertGreaterEqual(account["daysRemaining"], 7)

        second_token, second_account = self.store.login(
            "EDITOR@example.com", "password123", "device-0001", "Estudio"
        )
        self.assertNotEqual(token, second_token)
        self.assertEqual(second_account["deviceCount"], 1)

    def test_only_two_devices_are_allowed(self):
        self.store.register(
            "devices@example.com", "password123", "device-0001", "Uno"
        )
        self.store.login(
            "devices@example.com", "password123", "device-0002", "Dos"
        )
        with self.assertRaises(LicenseError):
            self.store.login(
                "devices@example.com", "password123", "device-0003", "Tres"
            )

    def test_gift_extends_access_and_cannot_be_reused(self):
        token, before = self.store.register(
            "gift@example.com", "password123", "device-0001", "Estudio"
        )
        after = self.store.redeem(token, "GOTA-PRUEBA-1-MES")
        self.assertEqual(after["status"], "gift")
        self.assertGreater(after["daysRemaining"], before["daysRemaining"])
        with self.assertRaises(LicenseError):
            self.store.redeem(token, "GOTA-PRUEBA-1-MES")

    def test_custom_gift_can_grant_requested_months(self):
        token, before = self.store.register(
            "custom@example.com", "password123", "device-0001", "Estudio"
        )
        code = self.store.create_gift_code(
            duration_days=180, max_redemptions=1, expires_in_days=7
        )
        after = self.store.redeem(token, code)
        self.assertGreaterEqual(
            after["daysRemaining"] - before["daysRemaining"], 180
        )


if __name__ == "__main__":
    unittest.main()
