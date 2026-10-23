"""Offline fixtures: Release assets must share the fixed Android certificate."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("prepare_release", Path(__file__).with_name("prepare-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="image-studio-release-")
        self.root = Path(self.temp.name)
        self.artifacts = self.root / "artifacts"
        self.output = self.root / "release"
        self.tag = "v" + json.loads((Path(__file__).resolve().parent.parent / "package.json").read_text(encoding="utf-8"))["version"]
        self.fingerprint = "ab" * 32
        windows = self.artifacts / "gpt-image-studio-windows-x64"
        windows.mkdir(parents=True)
        (windows / "gpt-image-studio.exe").write_bytes(b"windows portable fixture")
        (windows / "image-studio-x64-setup.exe").write_bytes(b"windows installer fixture")
        for abi in ("arm64-v8a",):
            folder = self.artifacts / ("gpt-image-studio-android-" + abi)
            folder.mkdir()
            (folder / "app-release-signed.apk").write_bytes(b"signed apk fixture")
            (folder / "android-signing-cert.sha256").write_bytes((self.fingerprint + "\n").encode())

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, expected=""):
        with patch.dict(os.environ, {"ANDROID_SIGNING_CERT_SHA256": expected}), contextlib.redirect_stdout(io.StringIO()):
            release.prepare(self.tag, self.artifacts, self.output)

    def test_supported_targets_and_checksum_and_public_certificate(self):
        self.prepare(":".join(["AB"] * 32))
        self.assertEqual((self.output / "ANDROID_SIGNING_CERT_SHA256").read_text().strip(), self.fingerprint)
        sums = (self.output / "SHA256SUMS").read_text().splitlines()
        self.assertEqual(len(sums), 4)
        for line in sums:
            digest, name = line.split("  ")
            self.assertEqual(release.sha256_file(self.output / name), digest)
        self.assertEqual(len(list(self.output.glob("*.apk"))), 1)
        self.assertFalse(list(self.output.glob("*.jks")))

    def test_other_android_abis_are_not_published(self):
        for abi in ("armeabi-v7a", "x86_64"):
            folder = self.artifacts / ("gpt-image-studio-android-" + abi)
            folder.mkdir()
            (folder / "app-release-signed.apk").write_bytes(b"unsupported architecture")
        self.prepare()
        apks = list(self.output.glob("*.apk"))
        self.assertEqual(len(apks), 1)
        self.assertIn("arm64-v8a", apks[0].name)

    def test_missing_certificate_rejected(self):
        (self.artifacts / "gpt-image-studio-android-arm64-v8a/android-signing-cert.sha256").unlink()
        with self.assertRaisesRegex(ValueError, "expected one"):
            self.prepare()

    def test_pinned_certificate_cannot_be_changed(self):
        with self.assertRaisesRegex(ValueError, "pinned"):
            self.prepare("cd" * 32)
        self.assertFalse(self.output.exists())

    def test_unsigned_apk_is_not_a_release_asset(self):
        folder = self.artifacts / "gpt-image-studio-android-arm64-v8a"
        (folder / "app-release-signed.apk").rename(folder / "app-release-unsigned.apk")
        with self.assertRaisesRegex(ValueError, "expected one"):
            self.prepare()

    def test_ambiguous_signed_apks_are_rejected(self):
        (self.artifacts / "gpt-image-studio-android-arm64-v8a/other-signed.apk").write_bytes(b"another apk")
        with self.assertRaisesRegex(ValueError, "found 2"):
            self.prepare()

    def test_empty_apk_rejected(self):
        (self.artifacts / "gpt-image-studio-android-arm64-v8a/app-release-signed.apk").write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "Empty artifact"):
            self.prepare()

    def test_existing_release_output_not_overwritten(self):
        self.output.mkdir()
        (self.output / "keep.txt").write_bytes(b"keep")
        with self.assertRaisesRegex(ValueError, "must be empty"):
            self.prepare()
        self.assertEqual((self.output / "keep.txt").read_bytes(), b"keep")

    def test_version_mismatch_rejected(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            release.prepare("v0.0.0", self.artifacts, self.output)

    def test_ci_only_builds_requested_targets(self):
        workflow = (Path(__file__).resolve().parent.parent / ".github/workflows/build.yml").read_text(encoding="utf-8")
        self.assertIn("--target x86_64-pc-windows-msvc", workflow)
        self.assertIn("--target aarch64", workflow)
        self.assertIn("targets: x86_64-pc-windows-msvc", workflow)
        self.assertIn("targets: aarch64-linux-android", workflow)
        self.assertNotIn("matrix.", workflow)
        self.assertNotIn("armv7-linux-androideabi", workflow)
        self.assertNotIn("x86_64-linux-android", workflow)

    def test_local_android_defaults_match_release_architecture(self):
        repo = Path(__file__).resolve().parent.parent
        package = json.loads((repo / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["scripts"]["android:apk"], "tauri android build --apk --ci --target aarch64")
        setup = (repo / "scripts/setup-android.ps1").read_text(encoding="utf-8")
        self.assertRegex(setup, r'\[string\[\]\]\$RustTargets\s*=\s*@\("aarch64-linux-android"\)')
        self.assertIn('$targets = @($RustTargets | Select-Object -Unique)', setup)
        self.assertNotIn('-KeyPassword <pwd>', setup)

    def test_ci_prepares_native_background_compile_sdk(self):
        repo = Path(__file__).resolve().parent.parent
        workflow = (repo / ".github/workflows/build.yml").read_text(encoding="utf-8")
        self.assertIn('"platforms;android-35" "build-tools;35.0.0"', workflow)
        self.assertIn('sdkmanager 不可用', workflow)

    def test_bad_certificate_rejected(self):
        for value in ("", "bad", "ab" * 31, "zz" * 32):
            with self.assertRaises(ValueError):
                release.certificate_fingerprint(value)


if __name__ == "__main__":
    unittest.main()
