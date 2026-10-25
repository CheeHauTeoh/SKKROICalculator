"""Map the current product layout from a LiDAR point cloud (+ optional Polycam DXF floor plan).

Builds, on a top-down grid:
  - local floor level (handles slabs and slopes)
  - stock top height per cell (points between the floor and --stock-cap, roof removed)
  - free floor (scanned floor with nothing on it) vs stock vs not scanned
and writes:
  orthophoto.png       true-colour top view of floor and stock, roof removed
  stock_height.png     how high goods are stacked, with walls and zones
  layout_report.md/json  per-zone floor area, stock footprint, free floor, stack heights, volume
  layout_grid.npz      the grids, for other tools (Blender scene, viewer)

Usage:
    python layout_map.py scan.laz --dxf floorplan.dxf --csv floorplan.csv --out out/
"""

import argparse
import csv
import json
import pathlib
import re

import numpy as np
from scipy import ndimage

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
from matplotlib.patches import Patch

import scan_io


def load_cloud(path):
    import laspy

    las = laspy.read(str(path))
    xyz = np.column_stack((las.x, las.y, las.z)).astype(np.float64)
    try:
        rgb = np.column_stack((las.red, las.green, las.blue)).astype(np.float64)
        rgb = (rgb / (256.0 if rgb.max() > 255 else 1.0)).clip(0, 255).astype(np.uint8)
    except AttributeError:
        rgb = np.full((len(xyz), 3), 160, np.uint8)
    return xyz, rgb


def load_dxf(path):
    """Walls (polylines) and zones (floor polygons + room label) from a Polycam DXF."""
    import ezdxf
    from shapely.geometry import Point, Polygon

    msp = ezdxf.readfile(str(path)).modelspace()
    walls = [np.array([(x, y) for x, y, *_ in e.get_points()])
             for e in msp.query('LWPOLYLINE[layer=="Polycam-Floor_1-Walls"]')]
    floors = [Polygon([(x, y) for x, y, *_ in e.get_points()]).buffer(0)
              for e in msp.query('LWPOLYLINE[layer=="Polycam-Floor_1-Floors"]')]
    labels = []
    for e in msp.query('MTEXT[layer=="Polycam-Floor_1-Labels-Rooms"]'):
        labels.append((re.sub(r"^\\A1;", "", e.text), e.dxf.insert.x, e.dxf.insert.y))
    zones = []
    for poly in floors:
        name = next((n for n, x, y in labels if poly.contains(Point(x, y))), "Room")
        zones.append({"polycam_name": name, "polygon": poly})
    zones.sort(key=lambda z: -z["polygon"].area)
    for i, zone in enumerate(zones):
        zone["id"] = chr(ord("A") + i)
    return walls, zones


def load_csv_heights(path):
    """Ceiling height per room from a Polycam floor-plan CSV, as text (may be a range)."""
    heights = {}
    with open(path, newline="") as handle:
        for row in csv.reader(handle):
            if len(row) >= 3 and row[1].startswith("Ceiling height"):
                heights[row[0]] = row[2].strip()
    return heights


def grid_index(xy, origin, cell, shape):
    ij = np.floor((xy - origin) / cell).astype(int)
    ok = (ij[:, 0] >= 0) & (ij[:, 1] >= 0) & (ij[:, 0] < shape[0]) & (ij[:, 1] < shape[1])
    return ij, ok


def local_floor(xyz, origin, shape, cell, coarse=0.5, window_m=2.0):
    """Floor height per cell: low percentile per coarse cell, gaps filled from neighbours."""
    factor = int(round(coarse / cell))
    cshape = (int(np.ceil(shape[0] / factor)), int(np.ceil(shape[1] / factor)))
    ij, ok = grid_index(xyz[:, :2], origin, coarse, cshape)
    flat = ij[ok, 0] * cshape[1] + ij[ok, 1]
    z = xyz[ok, 2]
    order = np.lexsort((z, flat))
    flat, z = flat[order], z[order]
    starts = np.r_[0, np.nonzero(np.diff(flat))[0] + 1]
    counts = np.diff(np.r_[starts, len(flat)])
    floor = np.full(cshape[0] * cshape[1], np.nan)
    good = counts >= 20
    floor[flat[starts[good]]] = z[starts[good] + (counts[good] * 0.02).astype(int)]
    floor = floor.reshape(cshape)
    # A cell whose lowest points sit well above its neighbours' floor is stock seen from above.
    window = max(3, int(window_m / coarse) | 1)
    ref = ndimage.generic_filter(np.where(np.isnan(floor), np.inf, floor), np.min, size=window)
    floor[floor > ref + 0.35] = np.nan
    # Fill gaps with the nearest measured floor, then smooth.
    missing = np.isnan(floor)
    if missing.all():
        raise SystemExit("No floor found in the scan")
    idx = ndimage.distance_transform_edt(missing, return_distances=False, return_indices=True)
    floor = floor[tuple(idx)]
    floor = ndimage.median_filter(floor, size=3)
    return np.kron(floor, np.ones((factor, factor)))[: shape[0], : shape[1]]


def build_grids(xyz, rgb, cell, stock_cap, min_points):
    origin = xyz[:, :2].min(axis=0) - cell
    shape = tuple(np.ceil((xyz[:, :2].max(axis=0) - origin) / cell).astype(int) + 2)
    floor = local_floor(xyz, origin, shape, cell)
    ij, ok = grid_index(xyz[:, :2], origin, cell, shape)
    ij, xyz, rgb = ij[ok], xyz[ok], rgb[ok]
    h = xyz[:, 2] - floor[ij[:, 0], ij[:, 1]]

    is_floor = np.abs(h) < 0.12
    is_stock = (h >= 0.12) & (h < stock_cap)
    floor_count = np.zeros(shape, np.int32)
    np.add.at(floor_count, (ij[is_floor, 0], ij[is_floor, 1]), 1)
    stock_count = np.zeros(shape, np.int32)
    np.add.at(stock_count, (ij[is_stock, 0], ij[is_stock, 1]), 1)

    # Highest stock point per cell (sort by height so the last write wins).
    top = np.zeros(shape)
    sel = np.nonzero(is_stock)[0]
    sel = sel[np.argsort(h[sel])]
    top[ij[sel, 0], ij[sel, 1]] = h[sel]
    top[stock_count < min_points] = 0

    # True-colour top view: highest point below the stock cap.
    colour = np.full(shape + (3,), 255, np.uint8)
    seen = np.zeros(shape, bool)
    sel = np.nonzero(h < stock_cap)[0]
    sel = sel[np.argsort(h[sel])]
    colour[ij[sel, 0], ij[sel, 1]] = rgb[sel]
    seen[ij[sel, 0], ij[sel, 1]] = True

    # Walls and columns: surfaces that carry on past the stock cap. Goods stacked
    # right up to the cap would also match, but hand-stacked cartons rarely do.
    above = (h >= stock_cap) & (h < stock_cap + 1.2)
    above_count = np.zeros(shape, np.int32)
    np.add.at(above_count, (ij[above, 0], ij[above, 1]), 1)
    structure = (above_count >= min_points) & (top >= stock_cap - 0.25)
    structure = ndimage.binary_dilation(structure)

    stock = (top >= 0.15) & ~structure
    stock = ndimage.binary_opening(stock)  # drop isolated specks
    free = (floor_count >= min_points) & ~stock & ~structure
    return {"origin": origin, "cell": cell, "floor": floor, "top": np.where(stock, top, 0.0),
            "stock": stock, "free": free, "structure": structure, "colour": colour, "seen": seen}


def fill_colour_gaps(colour, seen, iterations=2):
    """Fill single-cell holes in the sparse top view from neighbouring cells."""
    colour = colour.copy()
    for _ in range(iterations):
        missing = ~seen
        idx = ndimage.distance_transform_edt(missing, return_distances=True, return_indices=True)
        dist, (ii, jj) = idx
        fill = missing & (dist <= 1.5)
        colour[fill] = colour[ii[fill], jj[fill]]
        seen = seen | fill
    return colour, seen


def zone_masks(zones, grids):
    from shapely import contains_xy

    shape = grids["top"].shape
    xs = grids["origin"][0] + (np.arange(shape[0]) + 0.5) * grids["cell"]
    ys = grids["origin"][1] + (np.arange(shape[1]) + 0.5) * grids["cell"]
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    return {z["id"]: contains_xy(z["polygon"], gx, gy) for z in zones}


def wall_mask(walls, grids, half_width=0.2):
    """Cells within `half_width` of a floor-plan wall line."""
    from shapely import contains_xy
    from shapely.geometry import LineString
    from shapely.ops import unary_union

    shape = grids["top"].shape
    if not walls:
        return np.zeros(shape, bool)
    band = unary_union([LineString(w).buffer(half_width, cap_style="flat") for w in walls if len(w) > 1])
    xs = grids["origin"][0] + (np.arange(shape[0]) + 0.5) * grids["cell"]
    ys = grids["origin"][1] + (np.arange(shape[1]) + 0.5) * grids["cell"]
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    return contains_xy(band, gx, gy)


def zone_stats(zones, masks, grids, ceilings):
    area = grids["cell"] ** 2
    rows = []
    for zone in zones:
        m = masks[zone["id"]]
        stock = grids["stock"] & m
        free = grids["free"] & m
        heights = grids["top"][stock]
        rows.append({
            "zone": zone["id"],
            "polycam_name": zone["polycam_name"],
            "floor_area_m2": round(zone["polygon"].area, 1),
            "stock_footprint_m2": round(stock.sum() * area, 1),
            "free_floor_m2": round(free.sum() * area, 1),
            "not_scanned_m2": round(float((m & ~grids["stock"] & ~grids["free"] & ~grids["walls"]).sum() * area), 1),
            "stock_cover_pct": round(100 * stock.sum() * area / zone["polygon"].area, 0),
            "stack_height_avg_m": round(float(heights.mean()), 2) if len(heights) else 0.0,
            "stack_height_p90_m": round(float(np.percentile(heights, 90)), 2) if len(heights) else 0.0,
            "stock_volume_m3": round(float(heights.sum() * area), 0),
            "ceiling_height_m": ceilings.get(zone["polycam_name"], "n/a"),
        })
    return rows


def draw_plan(ax, walls, zones, grids, label_colour="#102a43"):
    for wall in walls:
        ax.plot(wall[:, 0], wall[:, 1], color="#1f2933", linewidth=2.2, solid_capstyle="butt")
    for zone in zones:
        x, y = zone["polygon"].exterior.xy
        ax.plot(x, y, color="#486581", linewidth=0.8, linestyle=(0, (4, 3)))
        c = zone["polygon"].representative_point()
        ax.text(c.x, c.y, f"Zone {zone['id']}", ha="center", va="center", fontsize=11, fontweight="bold",
                color=label_colour, bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="none", alpha=0.8))


def fade(ax, grids):
    """Wash out everything outside the floor plan."""
    veil = np.zeros(grids["top"].shape + (4,))
    veil[grids["outside"]] = (1, 1, 1, 0.75)
    ax.imshow(np.transpose(veil, (1, 0, 2)), origin="lower", extent=extent(grids), interpolation="nearest")


def finish_axes(ax, grids, title):
    shape = grids["top"].shape
    x0, y0 = grids["origin"]
    ax.set_xlim(x0, x0 + shape[0] * grids["cell"])
    ax.set_ylim(y0, y0 + shape[1] * grids["cell"])
    ax.set_aspect("equal")
    ax.set_xticks(np.arange(np.ceil(x0 / 5) * 5, x0 + shape[0] * grids["cell"], 5))
    ax.set_yticks(np.arange(np.ceil(y0 / 5) * 5, y0 + shape[1] * grids["cell"], 5))
    ax.grid(color="#9fb3c8", linewidth=0.4, alpha=0.6)
    ax.set_xlabel("metres")
    ax.set_title(title, loc="left", fontsize=13)


def extent(grids):
    shape = grids["top"].shape
    x0, y0 = grids["origin"]
    return (x0, x0 + shape[0] * grids["cell"], y0, y0 + shape[1] * grids["cell"])


def plot_orthophoto(path, grids, walls, zones):
    colour, _ = fill_colour_gaps(grids["colour"], grids["seen"])
    fig, ax = plt.subplots(figsize=(16, 8.5), dpi=150)
    ax.imshow(np.transpose(colour, (1, 0, 2)), origin="lower", extent=extent(grids), interpolation="nearest")
    fade(ax, grids)
    draw_plan(ax, walls, zones, grids)
    finish_axes(ax, grids, "Top view of floor and stock (roof removed), 5 m grid")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def plot_heights(path, grids, walls, zones, stock_cap):
    top = grids["top"]
    base = np.zeros(top.shape + (4,))
    base[grids["free"]] = (0.93, 0.95, 0.97, 1)  # free floor
    fig, ax = plt.subplots(figsize=(16, 8.5), dpi=150)
    ax.imshow(np.transpose(base, (1, 0, 2)), origin="lower", extent=extent(grids), interpolation="nearest")
    ramp = ListedColormap(plt.get_cmap("YlOrRd")(np.linspace(0.15, 1, 256)))
    heights = np.ma.masked_where(~grids["stock"], top)
    image = ax.imshow(heights.T, origin="lower", extent=extent(grids), cmap=ramp, vmin=0, vmax=min(3.0, stock_cap),
                      interpolation="nearest")
    fade(ax, grids)
    draw_plan(ax, walls, zones, grids)
    finish_axes(ax, grids, "Stock stack height above floor")
    bar = fig.colorbar(image, ax=ax, fraction=0.025, pad=0.01)
    bar.set_label("stack height (m)")
    ax.legend(handles=[Patch(fc=(0.93, 0.95, 0.97), ec="#9fb3c8", label="free floor (aisles, open space)"),
                       Patch(fc="white", ec="#9fb3c8", label="not scanned")],
              loc="lower left", fontsize=9, framealpha=0.9)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def write_report(out, rows, totals, args):
    lines = [
        "# Warehouse layout report",
        "",
        f"Source: `{pathlib.Path(args.scan).name}`"
        + (f" + `{pathlib.Path(args.dxf).name}`" if args.dxf else ""),
        f"Stock = anything 0.15-{args.stock_cap} m above the local floor; higher points are treated as roof.",
        "",
        "| Zone | Polycam label | Floor m² | Stock footprint m² | Free floor m² | Not scanned m² | Covered | Avg stack m | 90% stack m | Stock vol m³ | Ceiling m |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['zone']} | {r['polycam_name']} | {r['floor_area_m2']} | {r['stock_footprint_m2']} | "
            f"{r['free_floor_m2']} | {r['not_scanned_m2']} | {r['stock_cover_pct']:.0f}% | {r['stack_height_avg_m']} | "
            f"{r['stack_height_p90_m']} | {r['stock_volume_m3']:.0f} | {r['ceiling_height_m']} |")
    lines += [
        f"| **All** | | **{totals['floor_area_m2']}** | **{totals['stock_footprint_m2']}** | "
        f"**{totals['free_floor_m2']}** | **{totals['not_scanned_m2']}** | **{totals['stock_cover_pct']:.0f}%** | "
        f"{totals['stack_height_avg_m']} | | **{totals['stock_volume_m3']:.0f}** | |",
        "",
        "Notes:",
        "- Floor area is Polycam's room area. Walls (a 0.2 m strip along each plan wall, plus surfaces the scan shows rising "
        f"past {args.stock_cap} m) are left out of stock, free floor and not scanned.",
        "- Stock volume is the space under the top of each stack (gaps inside stacks included).",
        "- Phone LiDAR misses spots hidden behind tall stacks; those count as not scanned.",
        f"- {totals['stock_outside_floor_plan_m2']} m² of stock-height objects sit outside Polycam's walls (faded on the maps); "
        "the floor plan simplifies walls that are not square.",
        "- Polycam's room labels (Bedroom etc.) are automatic and wrong for a warehouse; zones are lettered by size.",
    ]
    (out / "layout_report.md").write_text("\n".join(lines) + "\n")
    (out / "layout_report.json").write_text(json.dumps({"zones": rows, "total": totals}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scan", help="LAS/LAZ point cloud (metres, Z up)")
    parser.add_argument("--dxf", help="Polycam floor-plan DXF (walls and rooms)")
    parser.add_argument("--csv", help="Polycam floor-plan CSV (ceiling heights)")
    parser.add_argument("--cell", type=float, default=0.1, help="Grid cell, metres")
    parser.add_argument("--stock-cap", type=float, default=3.3, help="Ignore points higher than this above the floor (roof)")
    parser.add_argument("--min-points", type=int, default=2)
    parser.add_argument("--out", default="out")
    args = parser.parse_args()

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    xyz, rgb = load_cloud(args.scan)
    grids = build_grids(xyz, rgb, args.cell, args.stock_cap, args.min_points)

    walls, zones = load_dxf(args.dxf) if args.dxf else ([], [])
    ceilings = load_csv_heights(args.csv) if args.csv else {}
    if not zones:  # no floor plan: one zone covering everything scanned
        from shapely.geometry import MultiPoint

        pts = grids["origin"] + (np.argwhere(grids["stock"] | grids["free"]) + 0.5) * args.cell
        zones = [{"id": "A", "polycam_name": "Scan", "polygon": MultiPoint(pts).convex_hull}]
    masks = zone_masks(zones, grids)
    walled = wall_mask(walls, grids)
    grids["stock"] &= ~walled
    grids["free"] &= ~walled
    grids["top"][walled] = 0.0
    grids["walls"] = walled | grids["structure"]
    grids["outside"] = ~np.any(np.stack(list(masks.values())), axis=0) if walls else np.zeros_like(walled)
    rows = zone_stats(zones, masks, grids, ceilings)

    area = args.cell ** 2
    inside = np.any(np.stack(list(masks.values())), axis=0)
    total_floor = sum(r["floor_area_m2"] for r in rows)
    heights = grids["top"][grids["stock"] & inside]
    totals = {
        "floor_area_m2": round(total_floor, 1),
        "stock_footprint_m2": round(sum(r["stock_footprint_m2"] for r in rows), 1),
        "free_floor_m2": round(sum(r["free_floor_m2"] for r in rows), 1),
        "not_scanned_m2": round(sum(r["not_scanned_m2"] for r in rows), 1),
        "stock_cover_pct": round(100 * sum(r["stock_footprint_m2"] for r in rows) / total_floor, 0),
        "stack_height_avg_m": round(float(heights.mean()), 2) if len(heights) else 0.0,
        "stock_volume_m3": round(sum(r["stock_volume_m3"] for r in rows), 0),
        "stock_outside_floor_plan_m2": round(float((grids["stock"] & ~inside).sum() * area), 1),
    }

    plot_orthophoto(out / "orthophoto.png", grids, walls, zones)
    plot_heights(out / "stock_height.png", grids, walls, zones, args.stock_cap)
    write_report(out, rows, totals, args)
    np.savez_compressed(out / "layout_grid.npz", origin=grids["origin"], cell=args.cell, floor=grids["floor"],
                        top=grids["top"], stock=grids["stock"], free=grids["free"])
    zone_geo = [{"id": z["id"], "polycam_name": z["polycam_name"],
                 "polygon": [list(map(float, p)) for p in z["polygon"].exterior.coords]} for z in zones]
    (out / "zones.json").write_text(json.dumps({"zones": zone_geo, "walls": [w.tolist() for w in walls]}))
    print(json.dumps(totals, indent=2))
    print((out / "layout_report.md").read_text())


if __name__ == "__main__":
    main()
