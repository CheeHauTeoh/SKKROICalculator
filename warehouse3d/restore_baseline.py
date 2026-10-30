"""Rebuild scan files stored in a private artifact, checking every checksum.

Scan data is kept out of this (public) repository. Instead each scan's files
are published to a private claude.ai artifact as a manifest.json plus data
files: binary files that artifacts cannot serve are stored base64-encoded
(gzipped first where that helps) in .txt parts.

1. Download the artifact's files with the Artifact tool:
   read `manifest.json`, then read every path listed under "parts" into one folder
   (keeping the published paths, e.g. <folder>/data/...).
2. python restore_baseline.py <folder> <output folder>

Prints each restored file and fails loudly on any size or checksum mismatch.
"""

import argparse
import base64
import gzip
import hashlib
import json
import pathlib
import sys


def restore(src, out):
    manifest = json.loads((src / "manifest.json").read_text())
    failures = 0
    for entry in manifest["files"]:
        try:
            if entry["base64"]:
                text = "".join((src / part).read_text().strip() for part in entry["parts"])
                data = base64.b64decode(text)
            else:
                data = b"".join((src / part).read_bytes() for part in entry["parts"])
        except FileNotFoundError as exc:
            print(f"MISSING  {entry['restore_as']}: {exc.filename} was not downloaded")
            failures += 1
            continue
        if entry["gzip"]:
            data = gzip.decompress(data)
        digest = hashlib.sha256(data).hexdigest()
        if len(data) != entry["bytes"] or digest != entry["sha256"]:
            print(f"BAD      {entry['restore_as']}: {len(data)} bytes, sha256 {digest[:12]}… "
                  f"(expected {entry['bytes']} bytes, {entry['sha256'][:12]}…)")
            failures += 1
            continue
        target = out / entry["restore_as"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        print(f"OK       {entry['restore_as']} ({entry['bytes']:,} bytes)")
    print(f"{manifest.get('scan', 'scan')}: {len(manifest['files']) - failures} of {len(manifest['files'])} files restored")
    return failures == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("src", type=pathlib.Path, help="Folder holding manifest.json and the downloaded data/ files")
    parser.add_argument("out", type=pathlib.Path, help="Where to write the restored files")
    args = parser.parse_args()
    sys.exit(0 if restore(args.src, args.out) else 1)


if __name__ == "__main__":
    main()
