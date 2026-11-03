"""Combine several Polycam scans into one master "virtual scan" and measure the total size.

Each scan is moved into the master frame (the baseline scan's LAZ/DXF coordinates)
and written out as one merged LAZ, DXF, CSV, OBJ and MTL, so the usual tools
(layout_map.py, build_blender_scene.py, build_layout_planner.py, build_viewer.py)
run on the whole warehouse unchanged. With --run they are run here.

A config JSON lists the scans (paths are relative to the config file):
  {"title": "...", "scans": [
    {"id": "scan_01_baseline", "number": 1, "captured": "2026-10-25",
     "laz": ..., "obj": ..., "dxf": ..., "csv": ..., "layout": "<layout_map.py output folder>",
     "placement": {"method": "master"}},
    {"id": "scan_02_bay", ..., "placement": {"method": "measured", "matrix": [[4x4]], "source": "registration.json"}},
    {"id": "scan_03_hall", ..., "placement": {"method": "description", "matrix": [[4x4]], "uncertainty_m": 1.0}},
    {"id": "scan_04_yard", ..., "placement": {"method": "unplaced"}}]}

Placement methods:
  master       the frame everything else is placed in (exactly one scan)
  measured     matrix from register_scan.py that passed its acceptance rule
  description  matrix set from my description of where the area is; approximate
  unplaced     position unknown: set beside the building in a row with a gap,
               outlined and captioned "position not confirmed", and kept out of
               the measured building size
Every scan's floor is levelled to the master's median floor height. Where placed
scans overlap, the newest scan is kept and older points and faces there are dropped.

Writes to --out: merged/ (master.laz, .dxf, .csv, .obj, .mtl, textures/),
annotations.json, placements.json, size_report.json/.md, coverage.png and,
with --run, layout/ (maps, report, Blender scene, planner) and viewer/.

Usage:
    python build_master.py master_config.json --out master/ --run [--notes notes.json] [--inline]
"""

import argparse
import csv
import datetime
import json
import pathlib
import re
import shutil
import subprocess
import sys

import numpy as np

import layout_map

HERE = pathlib.Path(__file__).resolve().parent
LAYERS = ["Polycam-Floor_1-Walls", "Polycam-Floor_1-Floors", "Polycam-Floor_1-Openings-Doors",
          "Polycam-Floor_1-Openings-Openings", "Polycam-Floor_1-Openings-Windows"]
LABELS = "Polycam-Floor_1-Labels-Rooms"
PLACED = ("master", "measured", "description")


def plan_polygon(zones):
    from shapely.ops import unary_union

    return unary_union([z["polygon"] for z in zones])


def transform_xy(geom, m):
    from shapely import affinity

    return affinity.affine_transform(geom, [m[0, 0], m[0, 1], m[1, 0], m[1, 1], m[0, 3], m[1, 3]])


def apply(m, xyz):
    return xyz @ m[:3, :3].T + m[:3, 3]


def resolve_placements(scans, gap):
    """4x4 matrix per scan in the master frame, floors levelled, unplaced scans set beside the building."""
    masters = [s for s in scans if s["placement"]["method"] == "master"]
    if len(masters) != 1:
        raise SystemExit("Exactly one scan needs placement method 'master'")
    master_floor = masters[0]["floor_z"]
    for s in scans:
        method = s["placement"]["method"]
        if method not in PLACED + ("unplaced",):
            raise SystemExit(f"{s['id']}: unknown placement method {method!r}")
        m = np.eye(4) if method in ("master", "unplaced") else np.array(s["placement"]["matrix"], float)
        m[2, 3] = master_floor - m[2, 2] * s["floor_z"]  # level the floor (registration is 2D)
        s["matrix"] = m
    placed = [s for s in scans if s["placement"]["method"] in PLACED]
    corners = np.array([transform_xy(s["extent"], s["matrix"]).bounds for s in placed])
    x0, y0 = corners[:, 0].min(), corners[:, 1].min()
    cursor = x0
    for s in scans:
        if s["placement"]["method"] != "unplaced":
            continue
        bx0, by0, bx1, by1 = s["extent"].bounds
        s["matrix"][0, 3] = cursor - bx0
        s["matrix"][1, 3] = (y0 - gap) - by1
        cursor += (bx1 - bx0) + gap


def keep_masks(scans):
    """Region of the master frame each placed scan loses to newer placed scans (newest wins)."""
    from shapely.ops import unary_union

    placed = sorted([s for s in scans if s["placement"]["method"] in PLACED], key=lambda s: s["captured"], reverse=True)
    newer = []
    for s in placed:
        s["drop"] = unary_union(newer) if newer else None
        newer.append(s["plan_master"])
    for s in scans:
        s.setdefault("drop", None)


def outside(region, xy):
    from shapely import contains_xy

    return np.ones(len(xy), bool) if region is None or region.is_empty else ~contains_xy(region, xy[:, 0], xy[:, 1])


def merge_laz(scans, path):
    import laspy

    parts = []
    for s in scans:
        las = laspy.read(str(s["laz"]))
        xyz = apply(s["matrix"], np.column_stack((las.x, las.y, las.z)))
        try:
            rgb = np.column_stack((las.red, las.green, las.blue)).astype(np.uint32)
            rgb = rgb * 256 if rgb.max() <= 255 else rgb
        except AttributeError:
            rgb = np.full((len(xyz), 3), 160 * 256, np.uint32)
        keep = outside(s["drop"], xyz)
        s["points_kept"], s["points_total"] = int(keep.sum()), len(xyz)
        parts.append((xyz[keep], rgb[keep].clip(0, 65535), np.full(int(keep.sum()), s["number"], np.uint16)))
    xyz = np.concatenate([p[0] for p in parts])
    header = laspy.LasHeader(point_format=3, version="1.2")
    header.scales = [0.001, 0.001, 0.001]
    header.offsets = np.floor(xyz.min(axis=0))
    las = laspy.LasData(header)
    las.x, las.y, las.z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    rgb = np.concatenate([p[1] for p in parts])
    las.red, las.green, las.blue = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    las.point_source_id = np.concatenate([p[2] for p in parts])
    las.write(str(path))
    return len(xyz)


def merge_dxf(scans, path):
    import ezdxf

    doc = ezdxf.new("R2018")
    doc.units = 6  # metres, as Polycam writes
    msp = doc.modelspace()
    for layer in LAYERS + [LABELS]:
        doc.layers.add(layer)
    for s in scans:
        m = s["matrix"]
        src = ezdxf.readfile(str(s["dxf"])).modelspace()
        for e in src.query("LWPOLYLINE"):
            if e.dxf.layer in LAYERS:
                pts = np.array([(x, y) for x, y, *_ in e.get_points()])
                pts = pts @ m[:2, :2].T + m[:2, 3]
                msp.add_lwpolyline([tuple(p) for p in pts], close=e.closed, dxfattribs={"layer": e.dxf.layer})
        for e in src.query(f'MTEXT[layer=="{LABELS}"]'):
            name = re.sub(r"^\\A1;", "", e.text)
            x, y = m[:2, :2] @ [e.dxf.insert.x, e.dxf.insert.y] + m[:2, 3]
            msp.add_mtext(f"{s['prefix']} {name}", dxfattribs={"layer": LABELS, "insert": (x, y)})
    doc.saveas(str(path))


def merge_csv(scans, path):
    with open(path, "w", newline="") as handle:
        out = csv.writer(handle)
        out.writerow(["Room", "Description", "Value"])
        for s in scans:
            with open(s["csv"], newline="") as src:
                for row in list(csv.reader(src))[1:]:
                    if len(row) >= 3 and row[0] not in ("Key", "Settings"):
                        out.writerow([f"{s['prefix']} {row[0]}"] + row[1:])


def polycam_totals(csv_path):
    totals = {}
    with open(csv_path, newline="") as handle:
        for row in csv.reader(handle):
            if len(row) >= 3 and row[0] == "Entire Roomplan" and "floor area" in row[1]:
                totals["exterior_m2" if "exterior" in row[1] else "usable_m2"] = float(row[2])
    return totals


def merge_obj(scans, out_dir):
    """One Y-up OBJ + MTL in the master frame; materials and textures prefixed per scan."""
    obj_lines, mtl_lines = ["mtllib master.mtl"], []
    (out_dir / "textures").mkdir(parents=True, exist_ok=True)
    v_off = vt_off = vn_off = 0
    for s in scans:
        m, prefix = s["matrix"], s["prefix"]
        lines = pathlib.Path(s["obj"]).read_text().splitlines()
        v = np.array([l.split()[1:4] for l in lines if l.startswith("v ")], float)
        vn = np.array([l.split()[1:4] for l in lines if l.startswith("vn ")], float).reshape(-1, 3)
        # OBJ is Y up: (x, y, z) -> Z up (x, -z, y), transform, then back.
        zup = apply(m, np.column_stack((v[:, 0], -v[:, 2], v[:, 1])))
        nzup = np.column_stack((vn[:, 0], -vn[:, 2], vn[:, 1])) @ m[:3, :3].T
        obj_lines += [f"v {x:.6f} {z:.6f} {-y:.6f}" for x, y, z in zup]
        obj_lines += [l for l in lines if l.startswith("vt ")]
        obj_lines += [f"vn {x:.6f} {z:.6f} {-y:.6f}" for x, y, z in nzup]
        # Drop faces whose centre lies where a newer scan is kept (first three corners; Polycam writes triangles).
        faces = [l for l in lines if l.startswith("f ")]
        first = np.array([[int(c.split("/")[0]) - 1 for c in f.split()[1:4]] for f in faces])
        keep = outside(s["drop"], zup[first, :2].mean(axis=1))
        s["faces_kept"], s["faces_total"] = int(keep.sum()), len(faces)
        offs = (v_off, vt_off, vn_off)
        n = 0
        for l in lines:
            if l.startswith("usemtl"):
                obj_lines.append(f"usemtl {prefix}_{l.split()[1]}")
            elif l.startswith("f "):
                if keep[n]:
                    obj_lines.append("f " + " ".join("/".join(str(int(x) + offs[k]) if x else ""
                                                              for k, x in enumerate(c.split("/")))
                                                     for c in l.split()[1:]))
                n += 1
        v_off += len(v)
        vt_off += sum(1 for l in lines if l.startswith("vt "))
        vn_off += len(vn)
        mtl = pathlib.Path(s["obj"]).parent / next(l.split(maxsplit=1)[1].strip() for l in lines if l.startswith("mtllib"))
        missing = []
        current = None
        for row in mtl.read_text().splitlines():
            if row.startswith("newmtl"):
                current = row.split(maxsplit=1)[1].strip()
                mtl_lines.append(f"newmtl {prefix}_{current}")
            elif row.startswith("map_Kd"):
                image = mtl.parent / row.split(maxsplit=1)[1].strip()
                target = f"textures/{prefix}_{image.name}"
                if image.exists():
                    shutil.copyfile(image, out_dir / target)
                else:
                    missing.append(current)
                mtl_lines.append(f"map_Kd {target}")
            else:
                mtl_lines.append(row)
        s["missing_textures"] = missing
    (out_dir / "master.obj").write_text("\n".join(obj_lines) + "\n")
    (out_dir / "master.mtl").write_text("\n".join(mtl_lines) + "\n")


def caption(s):
    method = s["placement"]["method"]
    name = f"Scan {s['number']:02d}"
    if method == "measured":
        return f"{name} · placed by wall match"
    if method == "description":
        return f"{name} · placed from description, ±{s['placement'].get('uncertainty_m', '?')} m"
    if method == "unplaced":
        return f"{name} · position not confirmed"
    return f"{name} · master frame"


def size_report(scans, out):
    from shapely.ops import unary_union

    def dims(geom):
        rect = geom.minimum_rotated_rectangle
        xy = np.array(rect.exterior.coords)
        sides = sorted({round(float(np.hypot(*(xy[i + 1] - xy[i]))), 1) for i in range(2)}, reverse=True)
        return sides if len(sides) == 2 else sides * 2

    def union_block(group):
        if not group:
            return None
        polys = [s["plan_master"] for s in group]
        union = unary_union(polys)
        return {"scans": [s["id"] for s in group], "area_m2": round(union.area, 1),
                "overlap_m2": round(sum(p.area for p in polys) - union.area, 1),
                "length_x_width_m": dims(union)}

    measured = [s for s in scans if s["placement"]["method"] in ("master", "measured")]
    described = [s for s in scans if s["placement"]["method"] == "description"]
    unplaced = [s for s in scans if s["placement"]["method"] == "unplaced"]
    report = {
        "scans": [{"id": s["id"], "number": s["number"], "captured": s["captured"],
                   "placement": s["placement"]["method"], "plan_area_m2": round(s["plan"].area, 1),
                   "plan_length_x_width_m": dims(s["plan"]), **{f"polycam_{k}": v for k, v in s["polycam"].items()},
                   "points_kept": s["points_kept"], "points_total": s["points_total"],
                   "faces_kept": s["faces_kept"], "faces_total": s["faces_total"],
                   "missing_textures": s["missing_textures"],
                   "matrix": np.round(s["matrix"], 6).tolist()} for s in scans],
        "measured_building": union_block(measured),
        "with_described": union_block(measured + described) if described else None,
        "unplaced_plan_area_m2": round(sum(s["plan"].area for s in unplaced), 1),
    }
    known = report["with_described"] or report["measured_building"]
    report["upper_bound_if_no_overlap_m2"] = round(known["area_m2"] + report["unplaced_plan_area_m2"], 1) if unplaced else None
    (out / "size_report.json").write_text(json.dumps(report, indent=1))

    mb = report["measured_building"]
    lines = ["# Warehouse size from the scans", "",
             f"Built {datetime.date.today().isoformat()} by build_master.py. Plan area is the area inside Polycam's floor "
             "plan (rooms), measured in the master frame; overlaps between scans are counted once.", "",
             "## Total size", "",
             f"- **Measured building** ({', '.join(mb['scans'])}): **{mb['area_m2']} m²** of plan area, about "
             f"{mb['length_x_width_m'][0]} × {mb['length_x_width_m'][1]} m overall (smallest enclosing rectangle). "
             f"Overlap between these scans: {mb['overlap_m2']} m²."]
    if report["with_described"]:
        wd = report["with_described"]
        lines.append(f"- **Including scans placed from a description** (approximate): {wd['area_m2']} m², about "
                     f"{wd['length_x_width_m'][0]} × {wd['length_x_width_m'][1]} m.")
    if unplaced:
        lines.append(f"- **Not placed:** {', '.join(s['id'] for s in unplaced)}, {report['unplaced_plan_area_m2']} m² "
                     "of plan area between them.")
        lines.append(f"- **Upper bound:** {report['upper_bound_if_no_overlap_m2']} m², only if no unplaced scan overlaps "
                     "anything already counted. This is an assumption, not a measurement.")
    lines += ["", "## Scans", "",
              "| Scan | Captured | Placement | Plan area m² | Plan length × width m | Polycam exterior m² | Polycam usable m² | Points kept | Missing textures |",
              "|---|---|---|---|---|---|---|---|---|"]
    for r in report["scans"]:
        lines.append(f"| {r['id']} | {r['captured']} | {r['placement']} | {r['plan_area_m2']} | "
                     f"{r['plan_length_x_width_m'][0]} × {r['plan_length_x_width_m'][1]} | {r.get('polycam_exterior_m2', '')} | "
                     f"{r.get('polycam_usable_m2', '')} | {r['points_kept']:,} of {r['points_total']:,} | "
                     f"{len(r['missing_textures'])} |")
    lines += ["", "Notes:",
              "- Unplaced scans are set beside the building in the master files and viewer so they can be seen, "
              "outlined and captioned \"position not confirmed\". Their position there means nothing.",
              "- Every scan's floor is levelled to the master scan's median floor height.",
              "- Where placed scans overlap, the newest scan is kept there; \"points kept\" shows what was dropped.",
              "- Phone LiDAR can drift a few percent over long distances. Check a long tape-measured distance on site."]
    (out / "size_report.md").write_text("\n".join(lines) + "\n")
    return report


def plot_coverage(scans, path):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(12, 9), dpi=120)
    colours = plt.get_cmap("tab10")
    for i, s in enumerate(scans):
        geoms = getattr(s["plan_master"], "geoms", [s["plan_master"]])
        for g in geoms:
            x, y = g.exterior.xy
            ax.fill(x, y, color=colours(i % 10), alpha=0.35, ec=colours(i % 10), lw=1.2)
        c = s["plan_master"].representative_point()
        ax.text(c.x, c.y, caption(s), ha="center", fontsize=9, fontweight="bold")
    ax.set_aspect("equal")
    ax.grid(alpha=0.4)
    ax.set_xlabel("metres (master frame)")
    ax.set_title("Which scan covers where", loc="left")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def default_notes(config, report, scans):
    """Viewer words written from the measurements only; edit them or pass --notes to replace them."""
    how = {"master": "the frame the others are placed in", "measured": "placed by wall match",
           "description": "placed from a description, approximate", "unplaced": "not placed"}
    mb = report["measured_building"]
    unplaced = [s for s in scans if s["placement"]["method"] == "unplaced"]
    shows = [f"The measured building ({', '.join(mb['scans'])}) covers {mb['area_m2']:.0f} m² of floor plan, about "
             f"{mb['length_x_width_m'][0]} by {mb['length_x_width_m'][1]} m overall."]
    for r in report["scans"]:
        shows.append(f"Scan {r['number']:02d} ({r['id']}, zones {r['number']}A onwards): {r['plan_area_m2']:.0f} m² "
                     f"of floor plan, {how[r['placement']]}.")
    if unplaced:
        shows.append("Scans that are not placed are set beside the building, outlined and captioned \"position not "
                     "confirmed\". Where they sit here means nothing.")
        shows.append(f"If none of them overlaps anything already counted, the whole warehouse is at most "
                     f"{report['upper_bound_if_no_overlap_m2']:.0f} m². That is an assumption, not a measurement.")
    return {
        "title": config.get("title", "Warehouse Master Scan"),
        "eyebrow": f"Master scan · {len(scans)} phone LiDAR scans · current layout",
        "lede": "All scans in one model, with stock, stack heights and open floor measured across the whole warehouse.",
        "app": "Polycam, iPhone LiDAR",
        "floor_note": (f"All {len(scans)} scans added up; measured building {mb['area_m2']:.0f} m²"
                       + (f", {len(unplaced)} scan{'s' if len(unplaced) != 1 else ''} not placed" if unplaced else "")),
        "zones_caption": "Zones are numbered by scan (1 = scan 01) and lettered by size within each scan, matching "
                         "each scan's own viewer. Polycam's room labels are shown in grey for reference.",
        "volume_note": "Space under the top of each stack, gaps included",
        "shows": shows,
        "method": ["Each scan is moved into the baseline scan's coordinates, with its floor levelled to the baseline floor.",
                   "Stock is anything 0.15 to 3.3 m above the local floor; higher points are treated as roof.",
                   "Where placed scans overlap, the newest scan is kept.",
                   "Phone LiDAR misses spots hidden behind tall stacks and can drift over long distances."],
        "foot": "Built with build_master.py and the warehouse3d tools from each scan's Polycam LAZ, DXF, CSV and OBJ exports.",
    }


def run(cmd):
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("config", type=pathlib.Path)
    p.add_argument("--out", type=pathlib.Path, required=True)
    p.add_argument("--gap", type=float, default=5.0, help="Metres between the building and unplaced scans")
    p.add_argument("--run", action="store_true", help="Also run layout_map, the Blender scene, the planner and the viewer")
    p.add_argument("--notes", type=pathlib.Path, help="Viewer notes JSON (default: written from the size report)")
    p.add_argument("--inline", action="store_true", help="Viewer as one HTML file that opens from disk")
    args = p.parse_args()

    config = json.loads(args.config.read_text())
    base = args.config.resolve().parent
    scans = config["scans"]
    for s in scans:
        for key in ("laz", "obj", "dxf", "csv", "layout"):
            s[key] = (base / s[key]).resolve()
        s["prefix"] = f"S{int(s['number']):02d}"
        grid = np.load(s["layout"] / "layout_grid.npz")
        s["floor_z"] = float(np.median(grid["floor"]))
        _, zones = layout_map.load_dxf(s["dxf"])
        s["plan"] = plan_polygon(zones)
        s["extent"] = s["plan"].envelope.union(layout_map_extent(grid)).envelope
        s["polycam"] = polycam_totals(s["csv"])

    resolve_placements(scans, args.gap)
    for s in scans:
        s["plan_master"] = transform_xy(s["plan"], s["matrix"])
    keep_masks(scans)

    merged = args.out / "merged"
    merged.mkdir(parents=True, exist_ok=True)
    points = merge_laz(scans, merged / "master.laz")
    merge_dxf(scans, merged / "master.dxf")
    merge_csv(scans, merged / "master.csv")
    merge_obj(scans, merged)
    annotations = [{"label": caption(s), "polygon": [list(map(float, c)) for c in
                                                     transform_xy(s["plan"], s["matrix"]).buffer(0.6).envelope.exterior.coords[:-1]]}
                   for s in scans if s["placement"]["method"] != "master"]
    (args.out / "annotations.json").write_text(json.dumps(annotations, indent=1))
    (args.out / "placements.json").write_text(json.dumps(
        [{"id": s["id"], "method": s["placement"]["method"], "matrix": np.round(s["matrix"], 6).tolist(),
          **{k: v for k, v in s["placement"].items() if k not in ("method", "matrix")}} for s in scans], indent=1))
    report = size_report(scans, args.out)
    plot_coverage(scans, args.out / "coverage.png")
    print(f"Merged {len(scans)} scans: {points:,} points -> {merged}")
    print((args.out / "size_report.md").read_text())

    if args.run:
        py, layout, laz, obj = sys.executable, args.out / "layout", merged / "master.laz", merged / "master.obj"
        run([py, HERE / "layout_map.py", laz, "--dxf", merged / "master.dxf", "--csv", merged / "master.csv",
             "--zone-ids-from-labels", "--annotations", args.out / "annotations.json", "--out", layout])
        run([py, HERE / "build_blender_scene.py", obj, "--scan", laz, "--layout", layout, "--out", layout])
        run([py, HERE / "build_layout_planner.py", obj, "--scan", laz, "--layout", layout, "--out", layout])
        notes = args.notes
        if notes is None:
            notes = args.out / "viewer_notes.json"
            notes.write_text(json.dumps(default_notes(config, report, scans), indent=1))
        run([py, HERE / "build_viewer.py", "--scan", laz, "--obj", obj, "--layout", layout, "--notes", notes,
             "--out", args.out / "viewer"] + (["--inline"] if args.inline else []))


def layout_map_extent(grid):
    """Everything the scan's points cover (its layout grid), as a box in the scan's own frame."""
    from shapely.geometry import box

    x0, y0 = grid["origin"]
    nx, ny = grid["top"].shape
    cell = float(grid["cell"])
    return box(x0, y0, x0 + nx * cell, y0 + ny * cell)


if __name__ == "__main__":
    main()
