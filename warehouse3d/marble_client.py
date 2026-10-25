"""Generate a 3D world from warehouse video/photos with the World Labs Marble API.

Uploads the media, starts a world generation, polls until it finishes, then
downloads the collider mesh (.glb) and the full world JSON (which carries
`assets.splats.semantics_metadata.metric_scale_factor`).

Field names follow the public docs at https://docs.worldlabs.ai/api as seen
through search snippets; they were NOT verified against the live API from this
environment. Use --dry-run to inspect the request body before spending credits.

Usage:
    export WLT_API_KEY=...
    python marble_client.py --video walkthrough.mp4 --out out/
    python marble_client.py --images front.jpg back.jpg --azimuths 0 180 --out out/
"""

import argparse
import json
import os
import pathlib
import sys
import time

import requests

API_BASE = "https://api.worldlabs.ai/marble/v1"
DEFAULT_MODEL = "marble-1.1"
DEFAULT_PROMPT = "Empty industrial warehouse interior, accurate geometry, true proportions"


def find_key(obj, key):
    """Return the first value for `key` anywhere in a nested JSON object."""
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for value in obj.values():
            found = find_key(value, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = find_key(value, key)
            if found is not None:
                return found
    return None


class MarbleClient:
    def __init__(self, api_key):
        self.session = requests.Session()
        self.session.headers.update({"WLT-Api-Key": api_key})

    def _request(self, method, path, **kwargs):
        response = self.session.request(method, f"{API_BASE}{path}", timeout=120, **kwargs)
        if not response.ok:
            raise RuntimeError(f"{method} {path} -> {response.status_code}: {response.text}")
        return response.json()

    def upload(self, path, kind):
        path = pathlib.Path(path)
        prepared = self._request(
            "POST",
            "/media-assets:prepare_upload",
            json={"file_name": path.name, "kind": kind, "extension": path.suffix.lstrip(".").lower()},
        )
        media_asset_id = find_key(prepared, "media_asset_id")
        upload_url = find_key(prepared, "upload_url")
        if not media_asset_id or not upload_url:
            raise RuntimeError(f"Unexpected prepare_upload response: {json.dumps(prepared)}")
        method = find_key(prepared, "upload_method") or "PUT"
        headers = find_key(prepared, "required_headers") or {}
        with path.open("rb") as handle:
            response = requests.request(method, upload_url, data=handle, headers=headers, timeout=600)
        if not response.ok:
            raise RuntimeError(f"Upload of {path} failed: {response.status_code} {response.text}")
        return media_asset_id

    def generate(self, body):
        return self._request("POST", "/worlds:generate", json=body)

    def wait(self, operation_id, interval=15, timeout=1800):
        deadline = time.time() + timeout
        while time.time() < deadline:
            operation = self._request("GET", f"/operations/{operation_id}")
            if operation.get("done"):
                if operation.get("error"):
                    raise RuntimeError(f"Generation failed: {operation['error']}")
                return operation
            print(f"  waiting... {json.dumps(operation.get('metadata', {}))[:200]}", flush=True)
            time.sleep(interval)
        raise TimeoutError(f"Operation {operation_id} did not finish in {timeout}s")

    def get_world(self, world_id):
        return self._request("GET", f"/worlds/{world_id}")


def media_ref(media_asset_id):
    return {"source": "media_asset", "media_asset_id": media_asset_id}


def build_body(args, video_id=None, image_ids=()):
    if video_id:
        world_prompt = {"type": "video", "video_prompt": media_ref(video_id)}
    elif len(image_ids) == 1:
        world_prompt = {"type": "image", "image_prompt": media_ref(image_ids[0])}
    else:
        world_prompt = {
            "type": "multi-image",
            "multi_image_prompt": [
                {"azimuth": azimuth, "content": media_ref(image_id)}
                for azimuth, image_id in zip(args.azimuths, image_ids)
            ],
        }
    world_prompt["text_prompt"] = args.prompt
    return {"display_name": args.name, "model": args.model, "world_prompt": world_prompt}


def download(url, dest):
    with requests.get(url, stream=True, timeout=600) as response:
        response.raise_for_status()
        with open(dest, "wb") as handle:
            for chunk in response.iter_content(1 << 20):
                handle.write(chunk)
    return dest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--video", help="Walkthrough video (<100 MB, mp4)")
    source.add_argument("--images", nargs="+", help="One or more photos of the space")
    parser.add_argument("--azimuths", nargs="+", type=float, help="Viewing direction (deg) of each image")
    parser.add_argument("--out", default="out", help="Output directory")
    parser.add_argument("--name", default="Warehouse scan")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--dry-run", action="store_true", help="Print the request body and exit")
    args = parser.parse_args()

    if args.images and len(args.images) > 1:
        if not args.azimuths or len(args.azimuths) != len(args.images):
            parser.error("--azimuths needs one value per image for multi-image input")

    if args.dry_run:
        fake_ids = [f"<media_asset_id:{p}>" for p in (args.images or [])]
        video_id = f"<media_asset_id:{args.video}>" if args.video else None
        print(json.dumps(build_body(args, video_id, fake_ids), indent=2))
        return

    api_key = os.environ.get("WLT_API_KEY")
    if not api_key:
        sys.exit("Set WLT_API_KEY (create one at https://platform.worldlabs.ai)")

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    client = MarbleClient(api_key)

    print("Uploading media...")
    video_id = client.upload(args.video, "video") if args.video else None
    image_ids = [client.upload(p, "image") for p in (args.images or [])]

    body = build_body(args, video_id, image_ids)
    print("Starting generation...")
    operation = client.generate(body)
    operation_id = operation.get("operation_id") or operation.get("name") or operation.get("id")
    if not operation_id:
        raise RuntimeError(f"No operation id in response: {json.dumps(operation)}")
    finished = client.wait(operation_id)

    world_id = find_key(finished, "world_id")
    world = client.get_world(world_id) if world_id else finished.get("response", finished)
    (out / "world.json").write_text(json.dumps(world, indent=2))

    mesh_url = find_key(world, "collider_mesh_url")
    if not mesh_url:
        raise RuntimeError("World has no collider_mesh_url; see world.json")
    download(mesh_url, out / "collider.glb")

    print(f"Saved {out / 'world.json'} and {out / 'collider.glb'}")
    print(f"metric_scale_factor: {find_key(world, 'metric_scale_factor')}")
    print(f"Viewer: {find_key(world, 'world_marble_url')}")


if __name__ == "__main__":
    main()
