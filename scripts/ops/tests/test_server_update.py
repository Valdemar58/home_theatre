import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "deploy/server"))
import server_update as update


class UpdateTests(unittest.TestCase):
    def fixture(self, root):
        instance = Mock(root=root)
        original = {"image": "old", "httpPort": 5056, "modules": []}
        instance.config.return_value = original
        plan = {"id": "a" * 24, "image": "new", "label": "abc123456789", "startsAt": 1,
                "endsAt": int(time.time() * 1000) + 60000, "checksums": {}}
        stage = root / "updates" / plan["id"]
        stage.mkdir(parents=True)
        for name in update.OPS_FILES:
            (root / name).write_text("old content")
            (stage / name).write_text("new content")
            plan["checksums"][name] = hashlib.sha256(b"new content").hexdigest()
        (root / "update-plan.json").write_text(json.dumps(plan))
        return instance, plan

    def test_stale_timer_cannot_apply_another_plan(self):
        with tempfile.TemporaryDirectory() as folder:
            instance, _ = self.fixture(Path(folder))
            with self.assertRaisesRegex(ValueError, "Stale"):
                update.execute(instance, "b" * 24)
            instance.compose.assert_not_called()

    def test_expired_window_does_not_accept_a_stale_acknowledgement(self):
        with tempfile.TemporaryDirectory() as folder:
            instance, plan = self.fixture(Path(folder))
            plan["endsAt"] = 1
            with self.assertRaisesRegex(RuntimeError, "expired"):
                update.wait_ready(instance, plan)

    @patch.object(update, "cancel")
    @patch.object(update, "api", return_value={"protocol": 1})
    @patch.object(update, "restore_backup")
    @patch.object(update, "create_backup", return_value=Path("/synthetic/backup.tar.gz"))
    @patch.object(update, "wait_ready")
    def test_failed_health_restores_old_image_data_and_ops(self, ready, backup, restore, api, cancel):
        with tempfile.TemporaryDirectory() as folder:
            instance, plan = self.fixture(Path(folder))
            instance.up.side_effect = RuntimeError("candidate not healthy")
            with self.assertRaisesRegex(RuntimeError, "not healthy"):
                update.execute(instance, plan["id"])
            restore.assert_called_once_with(instance, Path("/synthetic/backup.tar.gz"), allow_active=True, safety_backup=False)
            self.assertEqual((Path(folder) / "compose.yml").read_text(), "old content")
            self.assertEqual(instance.save.call_args_list[-1].args[0]["image"], "old")
            cancel.assert_called_once_with(instance)

    @patch.object(update, "cancel")
    @patch.object(update, "restore_backup", side_effect=RuntimeError("restore failed"))
    @patch.object(update, "create_backup", return_value=Path("/synthetic/backup.tar.gz"))
    @patch.object(update, "wait_ready")
    def test_failed_rollback_keeps_maintenance_active(self, ready, backup, restore, cancel):
        with tempfile.TemporaryDirectory() as folder:
            instance, plan = self.fixture(Path(folder))
            instance.up.side_effect = RuntimeError("candidate not healthy")
            with self.assertRaisesRegex(RuntimeError, "restore failed"):
                update.execute(instance, plan["id"])
            cancel.assert_not_called()


if __name__ == "__main__":
    unittest.main()
