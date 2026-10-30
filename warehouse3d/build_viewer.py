"""Build the interactive scan viewer page (3D model, point cloud, maps, zone table).

Takes the outputs of layout_map.py and build_blender_scene.py plus the scan's
LAZ and textured OBJ, and writes a folder ready to publish as an artifact:
  index.html          the page (point cloud, maps and renders embedded)
  model/manifest.json + model/Material_N.txt (base64 geometry) + model/Material_N.jpg
Artifacts won't serve .bin, so mesh geometry ships as base64 text.

The words on the page come from a notes JSON, so nothing is invented here:
  {"title": ..., "eyebrow": ..., "lede": ..., "shows": [...], "method": [...], "foot": ...,
   "volume_note": "optional sentence under the stock volume figure"}

Usage:
    python build_viewer.py --scan scan.laz --obj scan.obj --layout out/ --notes notes.json --out viewer/
Publish viewer/index.html with every file under viewer/model/ as supporting files.
"""

import argparse
import base64
import html
import json
import pathlib

import numpy as np
from PIL import Image

import build_blender_scene as scene_tools
import layout_map

HERE = pathlib.Path(__file__).resolve().parent
Image.MAX_IMAGE_PIXELS = None


def jpeg_data_uri(path, width):
    image = Image.open(path).convert("RGB")
    if image.size[0] > width:
        image = image.resize((width, round(image.size[1] * width / image.size[0])), Image.LANCZOS)
    tmp = pathlib.Path(path).with_suffix(".viewer.jpg")
    image.save(tmp, quality=82, optimize=True)
    data = base64.b64encode(tmp.read_bytes()).decode()
    tmp.unlink()
    return "data:image/jpeg;base64," + data


def point_payload(laz, grid, stock_cap, target=250_000):
    """Downsampled colour points (cm, Z above median floor) + roof flag, base64.

    Spacing starts at 7 cm (enough for a whole building) and tightens for small
    scans until about `target` points remain.
    """
    xyz, rgb = layout_map.load_cloud(laz)
    for voxel in (0.07, 0.05, 0.04, 0.03):
        keys = np.floor(xyz / voxel).astype(np.int64)
        _, first = np.unique(keys, axis=0, return_index=True)
        if len(first) >= target:
            break
    first = np.sort(first)
    xyz, rgb = xyz[first], rgb[first]
    floor = grid["floor"]
    ij = np.clip(np.floor((xyz[:, :2] - grid["origin"]) / float(grid["cell"])).astype(int), 0, np.array(floor.shape) - 1)
    height = xyz[:, 2] - floor[ij[:, 0], ij[:, 1]]
    floor_z = float(np.median(floor))
    pos = np.round(np.column_stack((xyz[:, 0], xyz[:, 1], xyz[:, 2] - floor_z)) * 100).astype(np.int16)
    roof = (height > stock_cap).astype(np.uint8)
    blob = pos.tobytes() + rgb.astype(np.uint8).tobytes() + roof.tobytes()
    return base64.b64encode(blob).decode(), len(first), floor_z


def model_files(obj, images, scan, floor_z, out, texture_width=2048):
    """Per-material geometry (positions 2 mm steps, uv16, indices) as base64 text + JPEG textures."""
    textures = scene_tools.match_textures(obj, scan, images) if images else scene_tools.textures_from_mtl(obj)
    verts, uvs, groups = scene_tools.read_obj_faces(obj)
    (out / "model").mkdir(parents=True, exist_ok=True)
    manifest, tris = [], 0
    for name, faces in groups:
        if name not in textures:
            continue
        f = np.array(faces)
        uniq, inv = np.unique(f.reshape(-1, 2), axis=0, return_inverse=True)
        p = verts[uniq[:, 0] - 1]
        t = uvs[uniq[:, 1] - 1]
        pos = np.round(np.column_stack((p[:, 0], p[:, 1], p[:, 2] - floor_z)) * 500).astype(np.int16)
        uv = np.round(np.clip(t, 0, 1) * 65535).astype(np.uint16)
        idx = inv.reshape(-1).astype(np.uint16 if len(uniq) < 65536 else np.uint32)
        (out / "model" / f"{name}.txt").write_text(base64.b64encode(pos.tobytes() + uv.tobytes() + idx.tobytes()).decode())
        image = Image.open(textures[name]).convert("RGB")
        if image.size[0] > texture_width:
            image = image.resize((texture_width, round(image.size[1] * texture_width / image.size[0])), Image.LANCZOS)
        image.save(out / "model" / f"{name}.jpg", quality=80, optimize=True)
        manifest.append({"name": name, "bin": f"{name}.txt", "tex": f"{name}.jpg", "verts": int(len(uniq)),
                         "tris": int(len(f)), "index32": bool(len(uniq) >= 65536)})
        tris += len(f)
    (out / "model" / "manifest.json").write_text(json.dumps(manifest))
    return len(manifest), tris


def fmt(v, digits=0):
    return f"{v:,.{digits}f}"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--scan", required=True, help="LAS/LAZ point cloud")
    p.add_argument("--obj", required=True, help="Polycam textured OBJ")
    p.add_argument("--images", nargs="*", help="Renamed texture images (matched by colour against --scan)")
    p.add_argument("--layout", required=True, help="Folder with layout_map.py and build_blender_scene.py outputs")
    p.add_argument("--notes", required=True, help="JSON with the page's words (see module help)")
    p.add_argument("--stock-cap", type=float, default=3.3)
    p.add_argument("--out", required=True)
    args = p.parse_args()

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    layout = pathlib.Path(args.layout)
    notes = json.loads(pathlib.Path(args.notes).read_text())
    report = json.loads((layout / "layout_report.json").read_text())
    total, zones = report["total"], report["zones"]
    grid = np.load(layout / "layout_grid.npz")

    points_b64, point_count, floor_z = point_payload(args.scan, grid, args.stock_cap)
    import laspy
    raw_points = laspy.read(args.scan).header.point_count
    materials, tris = model_files(args.obj, args.images, args.scan, floor_z, out)

    floor = total["floor_area_m2"]
    walls = max(0.0, floor - total["stock_footprint_m2"] - total["free_floor_m2"] - total["not_scanned_m2"])
    shares = [(total["stock_footprint_m2"], "stock", "Stock"), (total["free_floor_m2"], "free", "Free floor"),
              (total["not_scanned_m2"], "gap", "Not scanned"), (walls, "wall", "Wall strips")]
    pct = lambda v: 100 * v / floor if floor else 0
    ceilings = [z["ceiling_height_m"] for z in zones if z["ceiling_height_m"] != "n/a"]
    ceiling_text = ("Ceilings " + ", ".join(dict.fromkeys(c.replace(" - ", "–") for c in ceilings)) + " m") if ceilings else ""
    e = html.escape

    meta = "\n".join(f"      <span>{e(k)}</span><b{' class=\"num\"' if num else ''}>{e(v)}</b>" for k, v, num in [
        ("Scan", notes.get("app", "Polycam, iPhone LiDAR"), False), ("Points", fmt(raw_points), True),
        ("Grid", f"{float(grid['cell']):.2f} m", True), ("Units", "metres", False)])
    figures = "\n".join([
        f'    <div class="fig"><span class="label">Floor area</span><span class="v num">{fmt(floor)}<small>m²</small></span>'
        f'<span class="d">{len(zones)} zone{"s" if len(zones) != 1 else ""} from the Polycam floor plan</span></div>',
        f'    <div class="fig hot"><span class="label">Stock footprint</span><span class="v num">{fmt(total["stock_footprint_m2"])}<small>m²</small></span>'
        f'<span class="d">{pct(total["stock_footprint_m2"]):.0f}% of the floor</span></div>',
        f'    <div class="fig"><span class="label">Free floor</span><span class="v num">{fmt(total["free_floor_m2"])}<small>m²</small></span>'
        f'<span class="d">Aisles and open floor, {pct(total["free_floor_m2"]):.0f}%</span></div>',
        f'    <div class="fig"><span class="label">Average stack</span><span class="v num">{total["stack_height_avg_m"]:.2f}<small>m</small></span>'
        f'<span class="d">{e(ceiling_text)}</span></div>',
        f'    <div class="fig"><span class="label">Stock volume</span><span class="v num">{fmt(total["stock_volume_m3"])}<small>m³</small></span>'
        f'<span class="d">{e(notes.get("volume_note", "Space under the top of each stack"))}</span></div>'])
    label = ", ".join(f"{name} {pct(v):.0f}%" for v, _, name in shares)
    cover = (f'    <div class="bar" role="img" aria-label="{e(label)}">\n'
             + "\n".join(f'      <span style="width:{pct(v):.1f}%;background:var(--{tok})"></span>' for v, tok, _ in shares)
             + '\n    </div>\n    <div class="legend">\n'
             + "\n".join(f'      <span><i style="background:var(--{tok})"></i>{name} {fmt(v)} m²</span>' for v, tok, name in shares)
             + "\n    </div>\n")
    bullets = lambda items: "\n".join(f"        <li>{e(t)}</li>" for t in items)

    zone_geo = json.loads((layout / "zones.json").read_text())
    zone_geo = {"zones": [{"id": z["id"], "polygon": [[round(x, 2), round(y, 2)] for x, y in z["polygon"]]}
                          for z in zone_geo["zones"]]}
    renders = {k: layout / f for k, f in [("top", "render_top.png"), ("sw", "render_cutaway_south_west.png"),
                                          ("ne", "render_cutaway_north_east.png")]}
    page = (HERE / "viewer_template.html").read_text()
    values = {
        "__TITLE__": e(notes["title"]), "__EYEBROW__": e(notes.get("eyebrow", "Phone LiDAR scan · current layout")),
        "__LEDE__": e(notes["lede"]), "__META__": meta, "__FIGURES__": figures, "__COVER__": cover,
        "__MODEL_CAPTION__": e(f"Polycam's textured mesh ({fmt(tris)} triangles, {materials} photo textures) "
                               f"or the {fmt(point_count)}-point cloud."),
        "__NOTES_SHOWS__": bullets(notes.get("shows", [])), "__NOTES_METHOD__": bullets(notes.get("method", [])),
        "__FOOT__": e(notes.get("foot", "")),
        "__IMG_HEIGHT__": jpeg_data_uri(layout / "stock_height.png", 1800),
        "__IMG_ORTHO__": jpeg_data_uri(layout / "orthophoto.png", 1800),
        "__IMG_TOP__": jpeg_data_uri(renders["top"], 1800),
        "__IMG_SW__": jpeg_data_uri(renders["sw"], 1400), "__IMG_NE__": jpeg_data_uri(renders["ne"], 1400),
        "__ZONES__": json.dumps(zone_geo), "__STATS__": json.dumps(report),
        "__POINT_COUNT__": str(point_count), "__POINTS__": points_b64,
    }
    for key, value in values.items():
        assert key in page, key
        page = page.replace(key, value)
    (out / "index.html").write_text(page)
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"Wrote {out / 'index.html'} ({(out / 'index.html').stat().st_size / 1e6:.1f} MB page, {size / 1e6:.1f} MB total), "
          f"{point_count:,} points, {materials} textured parts, {tris:,} triangles")


if __name__ == "__main__":
    main()
