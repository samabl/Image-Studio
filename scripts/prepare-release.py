"""收集 Windows / Android 构建产物，保留 ABI 并生成发布校验和。"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil


def unique_file(root: Path, pattern: str) -> Path:
    files = sorted(root.rglob(pattern))
    if len(files) != 1:
        raise ValueError(f"{root}/{pattern}: expected one artifact, found {len(files)}")
    if files[0].stat().st_size == 0:
        raise ValueError(f"Empty artifact: {files[0]}")
    return files[0]


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
    for abi in ("arm64-v8a", "armeabi-v7a", "x86_64"):
        root = artifacts / f"gpt-image-studio-android-{abi}"
        files.append((unique_file(root, "*-signed.apk"), f"gpt-image-studio-{tag}-android-{abi}.apk"))

    output.mkdir(parents=True, exist_ok=True)
    checksums = []
    for source, name in files:
        target = output / name
        shutil.copyfile(source, target)
        with target.open("rb") as fh:
            digest = hashlib.file_digest(fh, "sha256").hexdigest()
        checksums.append(f"{digest}  {name}\n")
        print(f"{name}: {target.stat().st_size} bytes")
    (output / "SHA256SUMS").write_text("".join(checksums), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.tag, args.artifacts, args.output)
