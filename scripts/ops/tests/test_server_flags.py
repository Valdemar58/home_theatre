import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "deploy/server"))
import home_theater as flags
import home_theater as installer
import server_backup as backup


class FlagsTests(unittest.TestCase):
    def test_preparation_preserves_credentials_and_disabled_module_cache_configuration(self):
        config = {"modules": ["flags"]}
        server, application = {}, {}
        flags.flags_prepare(config, server, application)
        original = dict(server)
        flags.flags_prepare(config, server, application)
        self.assertEqual(server, original)
        self.assertEqual(server["UNLEASH_DATABASE_NAME"], "unleash")
        self.assertIn("UNLEASH_URL", application)
        flags.flags_prepare({"modules": []}, server, application)
        self.assertIn("UNLEASH_URL", application)

    def test_dedicated_role_credentials_go_only_over_stdin(self):
        instance = Mock()
        instance.config.return_value = {"unleashDatabaseName": "unleash"}
        with patch.object(installer, "run") as run:
            flags.flags_prepare_database(instance, values={"UNLEASH_DATABASE_PASSWORD": "a" * 48})
        args, kwargs = run.call_args
        self.assertNotIn("a" * 48, str(args))
        self.assertIn("NOSUPERUSER NOCREATEDB NOCREATEROLE", kwargs["data"])
        self.assertIn("REVOKE ALL", kwargs["data"])
        with self.assertRaises(ValueError):
            flags.flags_database_name({"unleashDatabaseName": "bad; DROP DATABASE calendar"})

    def test_local_override_is_a_veto_and_release_is_not_force_enable(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = Mock(root=Path(folder))
            (instance.root / "data").mkdir()
            with patch.object(flags.os, "chown"):
                flags.flags_override(instance, "ai-enabled", "off")
                target = instance.root / "data/feature-flags/overrides.json"
                self.assertEqual(json.loads(target.read_text())["disabled"], ["ai-enabled"])
                flags.flags_override(instance, "ai-enabled", "release")
                self.assertEqual(json.loads(target.read_text())["disabled"], [])
                self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                flags.flags_override(instance, "not-a-flag", "off")

    def test_flags_database_is_stopped_with_other_writers_and_restarted_only_when_enabled(self):
        instance = Mock()
        instance.config.return_value = {"modules": ["flags"]}
        instance.compose.return_value = "application\nunleash\n"
        with backup.stopped_writers(instance):
            pass
        self.assertIn("unleash", instance.compose.call_args.args)


if __name__ == "__main__":
    unittest.main()
