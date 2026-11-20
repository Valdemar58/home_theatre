"""Контракт установщика: повторный запуск сохраняет идентичность и не меняет образ."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch, Mock, call
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "deploy/server"))
SPEC = importlib.util.spec_from_file_location("installer", ROOT / "deploy/server/home_theater.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
PIN = "ghcr.io/example/product/server@sha256:" + "a" * 64


class InstallerTests(unittest.TestCase):
    def test_cached_immutable_images_do_not_require_registry_on_restart(self):
        for images, cached, should_pull in ((PIN + "\n", True, False),
                                             (PIN + "\n", False, True),
                                             ("postgres:17-alpine\n", True, True)):
            with self.subTest(images=images, cached=cached):
                instance = installer.Installation("/tmp/synthetic-installation")
                instance.config = Mock(return_value={"modules": []})
                instance.render = Mock()
                instance.compose = Mock(side_effect=lambda *args, **kwargs: images if args == ("config", "--images") else "")
                instance.lock_images = Mock()
                instance.doctor = Mock()
                with patch.object(installer.subprocess, "run", return_value=SimpleNamespace(returncode=0 if cached else 1)):
                    instance.up()
                self.assertEqual(call("pull") in instance.compose.call_args_list, should_pull)

    def test_only_safe_origins(self):
        for value in ("https://test.example.org", "http://127.0.0.1:5056", "http://localhost:5057/"):
            self.assertEqual(installer.validate_origin(value), value.rstrip("/"))
        for value in ("http://example.org", "https://user:pass@example.org", "https://example.org/x",
                      "https://example.org?token=x", "https://example.org#x", "file:///etc/passwd",
                      "https://example.org:foo", "https://example.org:444", "https://exa{mple.org"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                installer.validate_origin(value)

    def test_environment_cannot_inject_compose_or_shell(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "env"
            for value in ("x\nOTHER=secret", "${PASSWORD}", "$(id)", "'bad'", '"bad"', "x\\y", "x#y"):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    installer.write_env(target, {"VALUE": value})
            installer.write_env(target, {"VALUE": "https://example.org", "EMPTY": ""})
            self.assertEqual(installer.read_env(target)["VALUE"], "https://example.org")
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def args(self, folder, **kwargs):
        return SimpleNamespace(root=folder, image=None, origin=None, http_port=5056,
                               project="home-theater", modules="", bundle=str(ROOT / "deploy/server"), **kwargs)

    @patch("server_backup.daily_schedule")
    @patch.object(installer.Installation, "up")
    @patch.object(installer, "docker_install")
    @patch.object(installer, "check_platform")
    def test_reinstall_preserves_files_and_identity(self, platform, docker, up, schedule):
        with tempfile.TemporaryDirectory() as folder:
            state = {"schemaVersion": 1, "image": PIN, "origin": "http://127.0.0.1:5056",
                     "httpPort": 5056, "project": "home-theater", "modules": []}
            installer.write_json(Path(folder) / "installation.json", state)
            for name in ("server.env", "application.env", "user-data"):
                (Path(folder) / name).write_text("preserve-this-value")
            before = {file.name: file.read_bytes() for file in Path(folder).iterdir()}
            installer.install(self.args(folder))
            self.assertEqual({file.name: file.read_bytes() for file in Path(folder).iterdir()}, before)
            up.assert_called_once()
            schedule.assert_called_once()

    @patch.object(installer, "check_platform")
    def test_reinstall_cannot_silently_change_image_or_origin(self, platform):
        with tempfile.TemporaryDirectory() as folder:
            installer.write_json(Path(folder) / "installation.json", {"image": PIN, "origin": "https://test.example.org"})
            for image, origin in ((PIN[:-1] + "b", None), (None, "https://different.example.org")):
                args = self.args(folder)
                args.image, args.origin = image, origin
                with self.assertRaises(ValueError):
                    installer.install(args)

    @patch.object(installer, "check_platform")
    def test_unknown_existing_directory_is_not_overwritten(self, platform):
        with tempfile.TemporaryDirectory() as folder:
            existing = Path(folder) / "server.env"
            existing.write_text("keep")
            with self.assertRaises(ValueError):
                installer.install(self.args(folder))
            self.assertEqual(existing.read_text(), "keep")

    def test_degradation_clears_only_managed_endpoints(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = installer.Installation(folder)
            installer.write_env(Path(folder) / "server.env", {"POSTGRES_PASSWORD": "do-not-rotate"})
            installer.write_env(Path(folder) / "application.env", {
                "SESSION_SECRET": "keep", "PROWLARR_URL": "http://prowlarr:9696",
                "PROWLARR_API_KEY": "key", "SHIKIMORI_CLIENT_ID": "keep-client"})
            state = {"image": PIN, "origin": "https://test.example.org", "httpPort": 5056,
                     "project": "home-theater", "modules": []}
            instance.render(state)
            application = installer.read_env(Path(folder) / "application.env")
            self.assertEqual(application["PROWLARR_URL"], "")
            self.assertEqual(application["PROWLARR_API_KEY"], "")
            self.assertEqual(application["SESSION_SECRET"], "keep")
            self.assertEqual(application["SHIKIMORI_CLIENT_ID"], "keep-client")
            self.assertEqual(installer.read_env(Path(folder) / "server.env")["POSTGRES_PASSWORD"], "do-not-rotate")

    @patch.object(installer.Installation, "up")
    def test_explicit_https_preserves_identity_and_image(self, up):
        with tempfile.TemporaryDirectory() as folder:
            instance = installer.Installation(folder)
            original = {"image": PIN, "origin": "http://127.0.0.1:5056", "httpPort": 5056,
                        "project": "home-theater", "modules": ["search"]}
            instance.save(original)
            instance.origin("https://test.example.org")
            result = instance.config()
            self.assertEqual(result["image"], PIN)
            self.assertEqual(result["modules"], ["search", "https"])
            self.assertEqual(result["project"], original["project"])
            up.assert_called_once()

    @patch.object(installer.Installation, "up")
    @patch("server_backup.daily_schedule")
    @patch.object(installer.os, "chown")
    @patch.object(installer, "docker_install")
    @patch.object(installer, "check_platform")
    def test_fresh_install_has_private_secrets_and_readable_profiles(self, platform, docker, chown, schedule, up):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as bundle:
            for name in ("compose.yml", "Caddyfile", "modules.json", "home_theater.py", "home-theater", "server_backup.py", "server_update.py", "profiles.toml"):
                (Path(bundle) / name).write_text("fixture")
            args = self.args(folder)
            args.bundle, args.image = bundle, PIN
            installer.install(args)
            state = json.loads((Path(folder) / "installation.json").read_text())
            self.assertEqual(state["image"], PIN)
            self.assertEqual(state["modules"], [])
            for name in ("server.env", "application.env", "installation.json"):
                self.assertEqual((Path(folder) / name).stat().st_mode & 0o777, 0o600)
            self.assertEqual((Path(folder) / "profiles.toml").stat().st_mode & 0o777, 0o644)
            self.assertGreaterEqual(len(installer.read_env(Path(folder) / "application.env")["SESSION_SECRET"]), 32)


if __name__ == "__main__":
    unittest.main()
