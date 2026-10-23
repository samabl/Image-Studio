"""收集 Windows / Android 构建产物，保留 ABI 并生成发布校验和。"""

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil


def unique_file(root: Path, pattern: str) -> Path:
    files = sorted(root.rglob(pattern))
    if len(files) != 1:
        raise ValueError(f"{root}/{pattern}: expected one artifact, found {len(files)}")
    if files[0].stat().st_size == 0:
        raise ValueError(f"Empty artifact: {files[0]}")
    return files[0]


def certificate_fingerprint(value: str) -> str:
    value = re.sub(r"[:\s]", "", value).lower()
    if not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError("Invalid Android signing certificate SHA-256")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def prepare(tag: str, artifacts: Path, output: Path) -> None:
    repo = Path(__file__).resolve().parent.parent
    version = json.loads((repo / "package.json").read_text(encoding="utf-8"))["version"]
    if tag != f"v{version}":
        raise ValueError(f"Tag {tag!r} does not match package version {version!r}")
    if not (repo / "release-notes" / f"{tag}.md").is_file():
        raise ValueError(f"Missing release notes for {tag}")
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"Output directory must be empty: {output}")

    windows = artifacts / "gpt-image-studio-windows-x64"
    files = [
        (unique_file(windows, "gpt-image-studio.exe"), f"gpt-image-studio-{tag}-windows-x64.exe"),
        (unique_file(windows, "*-setup.exe"), f"gpt-image-studio-{tag}-windows-x64-setup.exe"),
    ]
    certificates = []
    for abi in ("arm64-v8a",):
        root = artifacts / f"gpt-image-studio-android-{abi}"
        files.append((unique_file(root, "*-signed.apk"), f"gpt-image-studio-{tag}-android-{abi}.apk"))
        cert = unique_file(root, "android-signing-cert.sha256")
        certificates.append(certificate_fingerprint(cert.read_text(encoding="utf-8")))
    if len(set(certificates)) != 1:
        raise ValueError("Android artifacts have different signing certificates; refusing Release")
    expected = os.environ.get("ANDROID_SIGNING_CERT_SHA256", "")
    if expected and certificates[0] != certificate_fingerprint(expected):
        raise ValueError("Android artifacts do not match the pinned Release signing certificate")

    output.mkdir(parents=True, exist_ok=True)
    checksums = []
    for source, name in files:
        target = output / name
        shutil.copyfile(source, target)
        digest = sha256_file(target)
        checksums.append(f"{digest}  {name}\n")
        print(f"{name}: {target.stat().st_size} bytes")
    # 公开的证书指纹不是私钥，供用户/后续发布核验覆盖升级的签名身份。
    cert_output = output / "ANDROID_SIGNING_CERT_SHA256"
    cert_output.write_bytes((certificates[0] + "\n").encode("utf-8"))
    checksums.append(f"{sha256_file(cert_output)}  {cert_output.name}\n")
    (output / "SHA256SUMS").write_bytes("".join(checksums).encode("utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.tag, args.artifacts, args.output)
