"""Package a scan's files for a private artifact (the reverse of restore_baseline.py).

Scan data must not go into this public repository. This script writes a folder
holding manifest.json plus data/ files that a claude.ai artifact can serve:
files with servable types (jpg, png, pdf, csv, json, md) are copied as they are;
everything else (laz, obj, mtl, dxf, npz, blend...) is base64-encoded into .txt
parts of at most 11 MB, gzipped first for text formats like OBJ. Publish the
folder's files with the Artifact tool (one publish carries up to 64 MB).

Usage:
    python archive_scan.py --scan scan_02_south --captured 2026-11-02 --out pkg/ \
        source/=path/to/polycam_exports/ derived/=path/to/layout_out/
Each argument is <prefix>=<file or folder>; folders are added recursively.
"""

import argparse
import base64
import gzip
import hashlib
import json
import os
import pathlib
import sys

SERVED = {".jpg", ".jpeg", ".png", ".pdf", ".csv", ".json", ".md", ".webp"}
GZIP = {".obj", ".mtl", ".dxf", ".ply", ".txt", ".xyz", ".pts"}
CHUNK = 11_000_000


def add(out, restore_as, src, entries):
    raw = src.read_bytes()
    suffix = src.suffix.lower()
    entry = {"restore_as": restore_as, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
             "gzip": False, "base64": False, "parts": []}
    if suffix in SERVED:
        name = f"data/{restore_as}"
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        (out / name).write_bytes(raw)
        entry["parts"].append(name)
    else:
        data = raw
        if suffix in GZIP:
            data = gzip.compress(raw, 9)
            entry["gzip"] = True
        text = base64.b64encode(data).decode()
        entry["base64"] = True
        for i in range(0, len(text), CHUNK):
            name = f"data/{restore_as.replace('/', '__')}.{i // CHUNK:02d}.txt"
            (out / name).parent.mkdir(parents=True, exist_ok=True)
            (out / name).write_text(text[i:i + CHUNK])
            entry["parts"].append(name)
    entries.append(entry)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("items", nargs="+", help="<prefix>=<file or folder>")
    parser.add_argument("--scan", required=True)
    parser.add_argument("--captured", default="")
    parser.add_argument("--app", default="Polycam (iPhone LiDAR)")
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()

    entries = []
    for item in args.items:
        prefix, _, path = item.partition("=")
        path = pathlib.Path(path)
        files = sorted(p for p in path.rglob("*") if p.is_file()) if path.is_dir() else [path]
        for f in files:
            rel = f.relative_to(path).as_posix() if path.is_dir() else f.name
            add(args.out, prefix + rel, f, entries)
    manifest = {"scan": args.scan, "captured": args.captured, "app": args.app, "files": entries}
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    total = sum(os.path.getsize(p) for p in args.out.rglob("*") if p.is_file())
    print(f"{len(entries)} files packaged, {total / 1e6:.1f} MB to publish")
    if total > 60e6:
        print("Over ~60 MB: publish in several calls to the same artifact URL (64 MB per publish).", file=sys.stderr)


if __name__ == "__main__":
    main()
