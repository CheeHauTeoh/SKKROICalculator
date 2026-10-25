"""Scale a reconstructed warehouse mesh in Blender and measure the space.

Imports a .glb (e.g. the Marble collider mesh), applies a real-world scale,
then reports floor footprint, floor area, obstructed area and ceiling height.
Writes a scaled .blend for layout work in Blender, an SVG floor plan and a
JSON/Markdown report.

Scale sources, in order of preference:
  --ref-model A --ref-real B   a distance you measured in the raw model (A units)
                               and on site with a tape/laser (B metres)
  --scale S                    explicit factor
  --world-json world.json      Marble's semantics_metadata.metric_scale_factor
Without any of these the numbers are in raw model units and flagged UNCALIBRATED.

Usage (with the bpy module installed, no Blender GUI needed):
    python blender_measure.py out/collider.glb --ref-model 3.71 --ref-real 10.0 --out out/
"""

import argparse
import json
import math
import pathlib

import bpy
import numpy as np
from scipy import ndimage

HORIZONTAL_NZ = 0.9   # |normal.z| above this counts as floor/ceiling-like
FLOOR_BAND = 0.15     # metres above the floor plane still treated as floor
OBSTACLE_MIN = 0.3    # geometry this high above the floor blocks floor use


def load_mesh(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit(f"No mesh found in {path}")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = "Warehouse"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def mesh_arrays(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    verts = np.empty(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", verts)
    tris = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
    mesh.loop_triangles.foreach_get("vertices", tris)
    return verts.reshape(-1, 3), tris.reshape(-1, 3)


def resolve_scale(args):
    if args.ref_model and args.ref_real:
        return args.ref_real / args.ref_model, f"reference distance {args.ref_model} units = {args.ref_real} m"
    if args.scale:
        return args.scale, "explicit --scale"
    if args.world_json:
        world = json.loads(pathlib.Path(args.world_json).read_text())
        factor = _find(world, "metric_scale_factor")
        if factor:
            return float(factor), "Marble metric_scale_factor (unverified - check a known distance)"
    return 1.0, "UNCALIBRATED (raw model units)"


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


def horizontal_levels(verts, tris, bin_size):
    """Area-weighted heights of horizontal faces -> (floor_z, ceiling_z)."""
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    cross = np.cross(b - a, c - a)
    area = np.linalg.norm(cross, axis=1) / 2
    with np.errstate(invalid="ignore", divide="ignore"):
        nz = np.abs(cross[:, 2]) / (2 * area)
    flat = (area > 0) & (nz > HORIZONTAL_NZ)
    z = (a[flat, 2] + b[flat, 2] + c[flat, 2]) / 3
    weights = area[flat]
    lo, hi = verts[:, 2].min(), verts[:, 2].max()
    bins = np.arange(lo, hi + bin_size, bin_size)
    hist, edges = np.histogram(z, bins=bins, weights=weights)
    centers = (edges[:-1] + edges[1:]) / 2
    mid = (lo + hi) / 2

    def refine(centre):
        near = np.abs(z - centre) <= bin_size
        return float(np.average(z[near], weights=weights[near]))

    floor_z = refine(centers[centers < mid][np.argmax(hist[centers < mid])])
    upper = centers >= mid
    ceiling_z = refine(centers[upper][np.argmax(hist[upper])]) if hist[upper].any() else float(hi)
    return floor_z, ceiling_z, flat


def rasterize(tris_xy, cell, origin, shape):
    """Mark grid cells whose centres fall inside any of the 2D triangles."""
    grid = np.zeros(shape, dtype=bool)
    for tri in tris_xy:
        x0, y0 = np.floor((tri.min(axis=0) - origin) / cell).astype(int)
        x1, y1 = np.ceil((tri.max(axis=0) - origin) / cell).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, shape[0]), min(y1, shape[1])
        if x1 <= x0 or y1 <= y0:
            continue
        xs = origin[0] + (np.arange(x0, x1) + 0.5) * cell
        ys = origin[1] + (np.arange(y0, y1) + 0.5) * cell
        px, py = np.meshgrid(xs, ys, indexing="ij")
        (ax, ay), (bx, by), (cx, cy) = tri
        d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
        d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
        d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
        neg = (d1 < 0) | (d2 < 0) | (d3 < 0)
        pos = (d1 > 0) | (d2 > 0) | (d3 > 0)
        grid[x0:x1, y0:y1] |= ~(neg & pos)
    return grid


def sample_surface(tris3d, spacing):
    """Points spread over each triangle no more than `spacing` apart."""
    chunks = []
    for tri in tris3d:
        edge = max(np.linalg.norm(tri[1] - tri[0]), np.linalg.norm(tri[2] - tri[1]), np.linalg.norm(tri[0] - tri[2]))
        n = max(1, int(math.ceil(edge / spacing)))
        i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing="ij")
        keep = i + j <= n
        u, v = i[keep] / n, j[keep] / n
        chunks.append(tri[0] + np.outer(u, tri[1] - tri[0]) + np.outer(v, tri[2] - tri[0]))
    return np.concatenate(chunks) if chunks else np.empty((0, 3))


def obstruction_grid(verts, tris, ceiling_h, cell, origin, shape, max_hole_m2=2.0):
    """Cells covered by geometry standing between knee height and the ceiling."""
    tri_z = verts[tris][:, :, 2]
    candidates = (tri_z.max(axis=1) > OBSTACLE_MIN) & (tri_z.min(axis=1) < ceiling_h - 0.3)
    points = sample_surface(verts[tris[candidates]], cell / 2)
    band = (points[:, 2] > OBSTACLE_MIN) & (points[:, 2] < ceiling_h - 0.3)
    idx = np.floor((points[band, :2] - origin) / cell).astype(int)
    idx = idx[(idx[:, 0] >= 0) & (idx[:, 1] >= 0) & (idx[:, 0] < shape[0]) & (idx[:, 1] < shape[1])]
    grid = np.zeros(shape, dtype=bool)
    grid[idx[:, 0], idx[:, 1]] = True
    # Columns that run to the ceiling only leave their outline; fill small enclosed holes.
    holes = ndimage.binary_fill_holes(grid) & ~grid
    labels, count = ndimage.label(holes)
    if count:
        sizes = ndimage.sum(holes, labels, index=np.arange(1, count + 1)) * cell * cell
        small = np.isin(labels, np.nonzero(sizes <= max_hole_m2)[0] + 1)
        grid |= small
    return grid


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


def write_svg(path, floor, blocked, cell, origin, grid_step=5.0):
    nx, ny = floor.shape
    px = 4  # pixels per cell
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
    step = int(round(grid_step / cell)) * px
    for x in range(0, w + 1, step):
        parts.append(f'<line x1="{x}" y1="0" x2="{x}" y2="{h}" stroke="#9fb3c8" stroke-width="0.5"/>')
    for y in range(0, h + 1, step):
        parts.append(f'<line x1="0" y1="{h - y}" x2="{w}" y2="{h - y}" stroke="#9fb3c8" stroke-width="0.5"/>')
    parts.append(f'<line x1="0" y1="{h + 20}" x2="{step}" y2="{h + 20}" stroke="#102a43" stroke-width="3"/>')
    parts.append(f'<text x="{step + 8}" y="{h + 24}">{grid_step:g} m grid</text>')
    parts.append(f'<text x="{w - 220}" y="{h + 24}">light = usable floor, dark = obstruction</text>')
    parts.append("</svg>")
    pathlib.Path(path).write_text("\n".join(parts))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mesh", help=".glb mesh to measure")
    parser.add_argument("--ref-model", type=float, help="Reference distance in raw model units")
    parser.add_argument("--ref-real", type=float, help="Same distance measured on site, metres")
    parser.add_argument("--scale", type=float, help="Explicit metres per model unit")
    parser.add_argument("--world-json", help="Marble world.json for metric_scale_factor")
    parser.add_argument("--cell", type=float, default=0.1, help="Floor-plan grid cell, metres")
    parser.add_argument("--out", default="out")
    args = parser.parse_args()

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    obj = load_mesh(args.mesh)
    scale, scale_source = resolve_scale(args)
    obj.scale = (scale, scale, scale)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    verts, tris = mesh_arrays(obj)
    floor_z, ceiling_z, flat = horizontal_levels(verts, tris, bin_size=0.05)

    # Put the floor at z=0 so heights read directly in Blender.
    obj.location.z -= floor_z
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    verts[:, 2] -= floor_z
    ceiling_h = ceiling_z - floor_z

    tri_z = verts[tris][:, :, 2]
    floor_tris = flat & (np.abs(tri_z).max(axis=1) < FLOOR_BAND)

    cell = args.cell
    xy = verts[:, :2]
    origin = xy.min(axis=0) - cell
    shape = tuple(np.ceil((xy.max(axis=0) - origin) / cell).astype(int) + 2)
    floor = rasterize(verts[tris[floor_tris]][:, :, :2], cell, origin, shape)
    blocked = obstruction_grid(verts, tris, ceiling_h, cell, origin, shape) & floor

    floor_pts = origin + (np.argwhere(floor) + 0.5) * cell
    length, width, angle = min_area_rectangle(floor_pts) if len(floor_pts) else (0, 0, 0)
    cell_area = cell * cell
    report = {
        "scale_m_per_unit": scale,
        "scale_source": scale_source,
        "footprint_length_m": round(float(length), 2),
        "footprint_width_m": round(float(width), 2),
        "footprint_rotation_deg": float(angle),
        "floor_area_m2": round(float(floor.sum() * cell_area), 1),
        "obstructed_area_m2": round(float(blocked.sum() * cell_area), 1),
        "usable_floor_area_m2": round(float((floor & ~blocked).sum() * cell_area), 1),
        "ceiling_height_m": round(float(ceiling_h), 2),
        "gross_volume_m3": round(float(floor.sum() * cell_area * ceiling_h), 0),
        "grid_cell_m": cell,
    }

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str((out / "warehouse_scaled.blend").resolve()))
    write_svg(out / "floor_plan.svg", floor, blocked, cell, origin)
    (out / "report.json").write_text(json.dumps(report, indent=2))

    units = "m" if scale_source != "UNCALIBRATED (raw model units)" else "units"
    md = [
        "# Warehouse measurement report",
        "",
        f"Scale: {scale:.4f} m/unit ({scale_source})",
        "",
        "| Measure | Value |",
        "|---|---|",
        f"| Footprint | {report['footprint_length_m']} x {report['footprint_width_m']} {units} |",
        f"| Floor area | {report['floor_area_m2']} {units}^2 |",
        f"| Obstructed (columns, racks, walls) | {report['obstructed_area_m2']} {units}^2 |",
        f"| Usable floor | {report['usable_floor_area_m2']} {units}^2 |",
        f"| Ceiling height | {report['ceiling_height_m']} {units} |",
        f"| Gross volume | {report['gross_volume_m3']} {units}^3 |",
        "",
        "Values come from a generated reconstruction. Verify 3-5 long distances on site before planning.",
    ]
    (out / "report.md").write_text("\n".join(md) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
