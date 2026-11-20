import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "deploy/server"))
import server_backup as backup

PIN = "ghcr.io/example/product/server@sha256:" + "a" * 64


def archive(path, extra=None, corrupt=False):
    files = {"database.dump": b"synthetic-database", "installation.json": b"{}",
             "application.env": b"SESSION_SECRET=synthetic", "server.env": b"POSTGRES_PASSWORD=synthetic"}
    files.update(extra or {})
    manifest = {"formatVersion": 1, "image": PIN,
                "files": {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}}
    if corrupt:
        manifest["files"]["database.dump"] = "0" * 64
    files["manifest.json"] = json.dumps(manifest).encode()
    with tarfile.open(path, "w:gz") as target:
        for name, content in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(content)
            target.addfile(member, io.BytesIO(content))


class BackupTests(unittest.TestCase):
    def test_verified_extract_and_corruption_refusal(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "backup.tar.gz"
            archive(source)
            output = root / "out"
            output.mkdir()
            self.assertEqual(backup.verify_backup(source, output)["image"], PIN)
            self.assertEqual((output / "application.env").stat().st_mode & 0o777, 0o600)
            archive(source, corrupt=True)
            with self.assertRaisesRegex(ValueError, "checksum"):
                backup.verify_backup(source)

    def test_paths_cannot_escape_or_alias_extraction_targets(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "backup.tar.gz"
            for name in ("../escape", "/absolute", "data/../../escape", "data/./alias", "data//alias", "data\\escape"):
                with self.subTest(name=name):
                    archive(path, {name: b"no"})
                    with self.assertRaises(ValueError):
                        backup.verify_backup(path)

    def test_links_are_never_extracted(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "backup.tar.gz"
            with tarfile.open(path, "w:gz") as target:
                link = tarfile.TarInfo("data/link")
                link.type, link.linkname = tarfile.SYMTYPE, "/etc/shadow"
                target.addfile(link)
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                backup.verify_backup(path)

    def test_incompatible_image_refuses_before_mutating_database(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "backup.tar.gz"
            archive(path)
            instance = Mock()
            instance.config.return_value = {"image": PIN[:-1] + "b"}
            with self.assertRaisesRegex(ValueError, "same server image"):
                backup.restore_backup(instance, path)
            instance.compose.assert_not_called()

    def test_media_and_regenerable_caches_are_excluded(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "data"
            for name in ("stream/episode.bin", "img-cache/poster.jpg", "pages/page.jpg", "plot/episode.mkv", "import/history.json"):
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("fixture")
            backup.copy_tree(source, root / "copy", data=True)
            self.assertEqual([file.relative_to(root / "copy").as_posix() for file in (root / "copy").rglob("*") if file.is_file()], ["import/history.json"])

    def test_restore_does_not_restart_a_module_disabled_by_restored_configuration(self):
        instance = Mock()
        instance.compose.return_value = "application\nprowlarr\n"
        instance.config.return_value = {"modules": []}
        with backup.stopped_writers(instance):
            pass
        self.assertIn(unittest.mock.call("up", "-d", "--wait", "--wait-timeout", "180", "application"), instance.compose.call_args_list)
        self.assertNotIn(unittest.mock.call("up", "-d", "--wait", "--wait-timeout", "180", "application", "prowlarr"), instance.compose.call_args_list)

    def test_failed_data_directory_swap_restores_original_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "backup.tar.gz"
            archive(source, {"installation.json": json.dumps({"modules": []}).encode()})
            (root / "data").mkdir()
            (root / "data/original.txt").write_text("retained")
            (root / "application.env").write_text("SESSION_SECRET=original\n")
            (root / "server.env").write_text("POSTGRES_PASSWORD=original\n")
            instance = Mock(root=root)
            instance.config.return_value = {"image": PIN, "origin": "http://127.0.0.1:5056", "modules": []}
            instance.compose.return_value = "application\n"
            real_replace = os.replace

            def fail_new_data(source, destination):
                if Path(source).parent.name.startswith(".restore-") and Path(source).name == "data":
                    raise OSError("Injected rename failure")
                return real_replace(source, destination)

            with patch.object(backup, "active_rooms", return_value=0), patch.object(backup, "binary_compose"), \
                    patch.object(backup, "create_backup"), patch.object(backup, "chown_tree"), \
                    patch.object(backup.os, "replace", side_effect=fail_new_data):
                with self.assertRaisesRegex(OSError, "Injected"):
                    backup.restore_backup(instance, source)
            self.assertEqual((root / "data/original.txt").read_text(), "retained")
            self.assertEqual((root / "application.env").read_text(), "SESSION_SECRET=original\n")


if __name__ == "__main__":
    unittest.main()
