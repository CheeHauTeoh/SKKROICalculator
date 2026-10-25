"""Measure a warehouse from a LiDAR scan or reconstructed mesh, via Blender.

Loads the scan (see scan_io.py for formats), puts it in metres with the floor
at z=0, then reports footprint, floor area, obstructed and usable area,
ceiling height and clear height under beams/pipes/lights. Writes a metric
.blend for layout work, an SVG floor plan and a JSON/Markdown report.

Scale, first match wins:
  --ref-model A --ref-real B   distance A in file units measured as B metres on site
  --scale S                    explicit metres per file unit
  --world-json world.json      World Labs Marble metric_scale_factor
  --units m|cm|mm|ft|in        file units (E57/LAS are always metres)
A mesh with none of these is flagged UNCALIBRATED.

Usage (with the bpy module installed, no Blender GUI needed):
    python blender_measure.py scan.e57 --out out/                 # Matterport / BLK2GO
    python blender_measure.py polycam.glb --units m --out out/    # iPhone LiDAR
    python blender_measure.py collider.glb --ref-model 3.71 --ref-real 10 --out out/   # Marble
"""

import argparse
import json
import math
import pathlib

import bpy
import numpy as np
from scipy import ndimage

import scan_io

FLOOR_BAND = 0.15     # metres above the floor plane still treated as floor
CEILING_MARGIN = 0.3  # ignore points this close under the ceiling plane


def _find(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        obj = list(obj.values())
    if isinstance(obj, list):
        for value in obj:
            found = _find(value, key)
            if found is not None:
                return found
    return None


def resolve_scale(args, suffix):
    if args.ref_model and args.ref_real:
        return args.ref_real / args.ref_model, f"reference distance {args.ref_model} units = {args.ref_real} m"
    if args.scale:
        return args.scale, "explicit --scale"
    if args.world_json:
        factor = _find(json.loads(pathlib.Path(args.world_json).read_text()), "metric_scale_factor")
        if factor:
            return float(factor), "Marble metric_scale_factor (unverified - check a known distance)"
    if args.units:
        return scan_io.UNIT_TO_M[args.units], f"file units: {args.units}"
    if suffix in scan_io.SCANNER_FORMATS:
        return 1.0, "scanner file (metres)"
    return 1.0, "UNCALIBRATED (raw model units)"


def floor_and_ceiling(z, bin_size=0.05):
    """Heights of the densest horizontal layers in the lower and upper halves."""
    lo, hi = np.percentile(z, [0.1, 99.9])
    bins = np.arange(lo, hi + bin_size, bin_size)
    hist, edges = np.histogram(z, bins=bins)
    centers = (edges[:-1] + edges[1:]) / 2
    mid = (lo + hi) / 2

    def refine(centre):
        return float(z[np.abs(z - centre) <= bin_size].mean())

    lower, upper = centers < mid, centers >= mid
    floor_z = refine(centers[lower][np.argmax(hist[lower])])
    ceiling_z = refine(centers[upper][np.argmax(hist[upper])])
    return floor_z, ceiling_z


def count_grid(points, cell, origin, shape):
    idx = np.floor((points[:, :2] - origin) / cell).astype(int)
    ok = (idx[:, 0] >= 0) & (idx[:, 1] >= 0) & (idx[:, 0] < shape[0]) & (idx[:, 1] < shape[1])
    grid = np.zeros(shape, dtype=np.int32)
    np.add.at(grid, (idx[ok, 0], idx[ok, 1]), 1)
    return grid


def fill_small_holes(mask, max_cells):
    holes = ndimage.binary_fill_holes(mask) & ~mask
    labels, count = ndimage.label(holes)
    if not count:
        return mask
    sizes = ndimage.sum(holes, labels, index=np.arange(1, count + 1))
    return mask | np.isin(labels, np.nonzero(sizes <= max_cells)[0] + 1)


def fill_narrow_holes(mask, max_width_cells):
    """Fill enclosed gaps narrower than `max_width_cells`, e.g. the hidden inside of a rack row.

    The scanner only sees a rack row's aisle faces, which leaves its inside as a
    long, thin enclosed hole. Wide enclosed areas (the floor inside the walls) stay open.
    """
    holes = ndimage.binary_fill_holes(mask) & ~mask
    labels, count = ndimage.label(holes)
    if not count:
        return mask
    radius = max(1, max_width_cells // 2)
    survivors = np.unique(labels[ndimage.binary_erosion(holes, iterations=radius)])
    return mask | (holes & ~np.isin(labels, survivors[survivors > 0]))


def min_area_rectangle(points):
    """Smallest rotated rectangle around 2D points -> (length, width, angle_deg)."""
    best = None
    for angle in np.arange(0, 90, 0.5):
        r = math.radians(angle)
        rot = points @ np.array([[math.cos(r), -math.sin(r)], [math.sin(r), math.cos(r)]])
        extent = rot.max(axis=0) - rot.min(axis=0)
        if best is None or extent[0] * extent[1] < best[0] * best[1]:
            best = (extent[0], extent[1], angle)
    length, width, angle = best
    return max(length, width), min(length, width), angle


def write_svg(path, floor, blocked, cell, grid_step=5.0):
    nx, ny = floor.shape
    px = max(1, min(4, int(1600 / max(nx, ny))))  # pixels per cell, plan at most ~1600 px wide
    w, h = nx * px, ny * px
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w + 80}" height="{h + 60}" '
        f'viewBox="-40 -20 {w + 80} {h + 60}" font-family="sans-serif" font-size="12">',
        f'<rect x="-40" y="-20" width="{w + 80}" height="{h + 60}" fill="#ffffff"/>',
    ]
    for (grid, colour) in ((floor & ~blocked, "#d9e2ec"), (blocked, "#334e68")):
        # One rectangle per horizontal run of cells keeps the file small.
        for j in range(ny):
            row = np.concatenate(([0], grid[:, j].astype(np.int8), [0]))
            starts = np.nonzero(np.diff(row) == 1)[0]
            ends = np.nonzero(np.diff(row) == -1)[0]
            for s, e in zip(starts, ends):
                parts.append(f'<rect x="{s * px}" y="{(ny - 1 - j) * px}" width="{(e - s) * px}" height="{px}" fill="{colour}"/>')
    step = max(1, int(round(grid_step / cell))) * px
    for x in range(0, w + 1, step):
        parts.append(f'<line x1="{x}" y1="0" x2="{x}" y2="{h}" stroke="#9fb3c8" stroke-width="0.5"/>')
    for y in range(0, h + 1, step):
        parts.append(f'<line x1="0" y1="{h - y}" x2="{w}" y2="{h - y}" stroke="#9fb3c8" stroke-width="0.5"/>')
    parts.append(f'<line x1="0" y1="{h + 20}" x2="{step}" y2="{h + 20}" stroke="#102a43" stroke-width="3"/>')
    parts.append(f'<text x="{step + 8}" y="{h + 24}">{grid_step:g} m grid</text>')
    parts.append(f'<text x="{w - 220}" y="{h + 24}">light = usable floor, dark = obstruction</text>')
    parts.append("</svg>")
    pathlib.Path(path).write_text("\n".join(parts))


def clear_height(points, usable, cell, origin, min_points, low, high):
    """Lowest overhead obstruction (beam, pipe, light) above usable floor."""
    overhead = points[(points[:, 2] >= low) & (points[:, 2] < high)]
    idx = np.floor((overhead[:, :2] - origin) / cell).astype(int)
    inside = (idx >= 0).all(axis=1) & (idx[:, 0] < usable.shape[0]) & (idx[:, 1] < usable.shape[1])
    overhead, idx = overhead[inside], idx[inside]
    over_usable = usable[idx[:, 0], idx[:, 1]]
    overhead, idx = overhead[over_usable], idx[over_usable]
    counts = np.zeros(usable.shape, dtype=np.int32)
    np.add.at(counts, (idx[:, 0], idx[:, 1]), 1)
    lowest = np.full(usable.shape, np.inf)
    np.minimum.at(lowest, (idx[:, 0], idx[:, 1]), overhead[:, 2])
    # Cells with only a stray point or two are scanner noise, not structure.
    solid = lowest[counts >= min_points]
    return float(np.percentile(solid, 1)) if len(solid) else None


def measure(points, cell, obstacle_band, min_points, rack_depth):
    floor_z, ceiling_z = floor_and_ceiling(points[:, 2])
    points = points - [0, 0, floor_z]
    ceiling_h = ceiling_z - floor_z
    low, high = obstacle_band[0], min(obstacle_band[1], ceiling_h - CEILING_MARGIN)

    origin = points[:, :2].min(axis=0) - cell
    shape = tuple(np.ceil((points[:, :2].max(axis=0) - origin) / cell).astype(int) + 2)
    if shape[0] * shape[1] > 400_000_000:
        raise SystemExit(f"Scan spans {shape[0] * cell:.0f} x {shape[1] * cell:.0f} m - wrong --units?")
    z = points[:, 2]
    floor_hits = count_grid(points[np.abs(z) < FLOOR_BAND], cell, origin, shape) >= min_points
    blocked = count_grid(points[(z > low) & (z < high)], cell, origin, shape) >= min_points
    # Close scan gaps, fill hollow columns and the unseen inside of rack rows.
    blocked = ndimage.binary_closing(blocked, iterations=1)
    blocked = fill_small_holes(blocked, int(2.0 / cell ** 2))
    blocked = fill_narrow_holes(blocked, int(round(rack_depth / cell)))
    floor = ndimage.binary_closing(floor_hits | blocked, iterations=2)
    floor = fill_small_holes(floor, int(25.0 / cell ** 2))
    blocked &= floor
    usable = floor & ~blocked

    clear_h = clear_height(points, usable, cell, origin, min_points, high, ceiling_h - CEILING_MARGIN)
    clear_h = ceiling_h if clear_h is None else clear_h

    floor_pts = origin + (np.argwhere(floor) + 0.5) * cell
    length, width, angle = min_area_rectangle(floor_pts) if len(floor_pts) else (0, 0, 0)
    cell_area = cell * cell
    report = {
        "footprint_length_m": round(float(length), 2),
        "footprint_width_m": round(float(width), 2),
        "footprint_rotation_deg": float(angle),
        "floor_area_m2": round(float(floor.sum() * cell_area), 1),
        "obstructed_area_m2": round(float(blocked.sum() * cell_area), 1),
        "usable_floor_area_m2": round(float(usable.sum() * cell_area), 1),
        "ceiling_height_m": round(float(ceiling_h), 2),
        "clear_height_m": round(clear_h, 2),
        "gross_volume_m3": round(float(floor.sum() * cell_area * ceiling_h), 0),
        "grid_cell_m": cell,
        "point_count": int(len(points)),
    }
    return report, floor, blocked, floor_z


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scan", help="Scan or mesh: .e57 .las .laz .ply .obj .glb .gltf .fbx .stl")
    parser.add_argument("--up", choices=("z", "y", "x"), default="z",
                        help="Up axis of the file after import (try y if the floor comes out as a wall)")
    parser.add_argument("--units", choices=sorted(scan_io.UNIT_TO_M), help="File units")
    parser.add_argument("--ref-model", type=float, help="Reference distance in file units")
    parser.add_argument("--ref-real", type=float, help="Same distance measured on site, metres")
    parser.add_argument("--scale", type=float, help="Explicit metres per file unit")
    parser.add_argument("--world-json", help="Marble world.json for metric_scale_factor")
    parser.add_argument("--cell", type=float, default=0.1, help="Floor-plan grid cell, metres")
    parser.add_argument("--obstacle-band", type=float, nargs=2, default=(0.3, 2.5), metavar=("LOW", "HIGH"),
                        help="Height range (m) where anything counts as a floor obstruction")
    parser.add_argument("--rack-depth", type=float, default=2.6,
                        help="Fill enclosed obstructions narrower than this (m): the hidden inside of rack rows")
    parser.add_argument("--voxel", type=float, default=0.03, help="Downsample scans to this spacing, metres")
    parser.add_argument("--min-points", type=int, default=3, help="Points per cell to count as occupied")
    parser.add_argument("--out", default="out")
    args = parser.parse_args()

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    suffix = pathlib.Path(args.scan).suffix.lower()
    scale, scale_source = resolve_scale(args, suffix)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    points, mesh_obj = scan_io.load_points(args.scan, up=args.up, unit_scale=scale, spacing=args.cell / 2)
    points = scan_io.voxel_downsample(points, args.voxel)
    report, floor, blocked, floor_z = measure(points, args.cell, args.obstacle_band, args.min_points, args.rack_depth)
    report = {"source": args.scan, "scale_m_per_unit": scale, "scale_source": scale_source, **report}

    if report["ceiling_height_m"] > report["footprint_width_m"]:
        print("WARNING: ceiling is higher than the building is wide - the up axis is probably wrong, try --up y")

    # Blender scene: metric, floor at z=0, mesh kept as-is or points displayed as dots.
    if mesh_obj is not None:
        mesh_obj.location.z -= floor_z
    else:
        scan_io.points_object(points - [0, 0, floor_z])
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str((out / "warehouse_scaled.blend").resolve()))
    write_svg(out / "floor_plan.svg", floor, blocked, args.cell)
    (out / "report.json").write_text(json.dumps(report, indent=2))

    units = "units" if scale_source.startswith("UNCALIBRATED") else "m"
    md = [
        "# Warehouse measurement report",
        "",
        f"Source: `{args.scan}` ({report['point_count']:,} points after downsampling)",
        f"Scale: {scale:.4f} m/unit ({scale_source})",
        "",
        "| Measure | Value |",
        "|---|---|",
        f"| Footprint | {report['footprint_length_m']} x {report['footprint_width_m']} {units} |",
        f"| Floor area | {report['floor_area_m2']} {units}^2 |",
        f"| Obstructed (columns, racks, walls) | {report['obstructed_area_m2']} {units}^2 |",
        f"| Usable floor | {report['usable_floor_area_m2']} {units}^2 |",
        f"| Ceiling height | {report['ceiling_height_m']} {units} |",
        f"| Clear height (under beams, pipes, lights) | {report['clear_height_m']} {units} |",
        f"| Gross volume | {report['gross_volume_m3']} {units}^3 |",
        "",
        "Check 3-5 long distances on site against these figures before ordering racking.",
    ]
    (out / "report.md").write_text("\n".join(md) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
