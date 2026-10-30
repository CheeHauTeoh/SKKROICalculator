"""Find where a new scan sits in the master (baseline) frame, using building structure only.

Stock moves between scans, so only walls are matched: each scan's Polycam DXF
walls plus the tall surfaces in its point cloud (anything rising past the
stock cap). For every rotation (1 degree steps) the new scan's walls are
rasterised and cross-correlated with the master's wall map to find the best
shift. Each candidate is scored on:
  overlap   share of the new scan's plan walls within 0.15 m of a master wall
  conflict  share of the new scan's open floor that lands on a master wall
              (a real fit puts no open floor inside walls)
  shared    area seen by both scans, m^2 (0 means they only touch along a wall)
The best few candidates are refined with point-to-point ICP on structure
points and reported with their RMS. A fit is accepted only if overlap >= 20 %,
RMS <= 0.05 m, conflict is low, and the winner clearly beats the runner-up.

Usage:
    python register_scan.py --master-laz base.laz --master-dxf base.dxf --master-grid base_out/layout_grid.npz \
        --scan-laz new.laz --scan-dxf new.dxf --scan-grid new_out/layout_grid.npz --out new_out/registration.json
"""

import argparse
import json
import math
import pathlib

import numpy as np
from scipy import ndimage, signal
from scipy.spatial import cKDTree

import layout_map

CELL = 0.1


def wall_samples(walls, spacing=0.05):
    pts = []
    for w in walls:
        for a, b in zip(w[:-1], w[1:]):
            n = max(2, int(np.linalg.norm(b - a) / spacing))
            t = np.linspace(0, 1, n)[:, None]
            pts.append(a + t * (b - a))
    return np.concatenate(pts)


def structure_points(laz, grid, cap):
    """3D points of surfaces rising past the stock cap (walls, columns), below the roof band."""
    xyz, _ = layout_map.load_cloud(laz)
    g = np.load(grid)
    ij = np.floor((xyz[:, :2] - g["origin"]) / float(g["cell"])).astype(int)
    ij = np.clip(ij, 0, np.array(g["floor"].shape) - 1)
    h = xyz[:, 2] - g["floor"][ij[:, 0], ij[:, 1]]
    tall_cell = np.zeros(g["floor"].shape, np.int32)
    sel = (h > cap) & (h < cap + 1.0)
    np.add.at(tall_cell, (ij[sel, 0], ij[sel, 1]), 1)
    keep = (tall_cell[ij[:, 0], ij[:, 1]] >= 3) & (h > 0.5) & (h < cap + 1.0)
    pts = xyz[keep]
    # Thin to ~5 cm and express heights above the local floor so floor offsets between scans cancel.
    pts = np.column_stack((pts[:, :2], h[keep]))
    key = np.floor(pts / 0.05).astype(np.int64)
    _, first = np.unique(key, axis=0, return_index=True)
    return pts[first]


def raster(points_xy, origin, shape):
    img = np.zeros(shape, np.float32)
    ij = np.floor((points_xy - origin) / CELL).astype(int)
    ok = (ij >= 0).all(axis=1) & (ij[:, 0] < shape[0]) & (ij[:, 1] < shape[1])
    img[ij[ok, 0], ij[ok, 1]] = 1
    return img


def rot(deg):
    r = math.radians(deg)
    return np.array([[math.cos(r), -math.sin(r)], [math.sin(r), math.cos(r)]])


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for who in ("master", "scan"):
        p.add_argument(f"--{who}-laz", required=True)
        p.add_argument(f"--{who}-dxf", required=True)
        p.add_argument(f"--{who}-grid", required=True)
    p.add_argument("--stock-cap", type=float, default=3.3)
    p.add_argument("--plan-walls-only", action="store_true",
                   help="Match against the master's DXF walls only (use when low roofs or tall stock clutter the scan's structure)")
    p.add_argument("--out", required=True)
    args = p.parse_args()

    m_walls, _ = layout_map.load_dxf(args.master_dxf)
    s_walls, _ = layout_map.load_dxf(args.scan_dxf)
    m_struct = structure_points(args.master_laz, args.master_grid, args.stock_cap)
    s_struct = structure_points(args.scan_laz, args.scan_grid, args.stock_cap)
    m_wall_xy = wall_samples(m_walls) if args.plan_walls_only else np.concatenate([wall_samples(m_walls), m_struct[:, :2]])
    s_plan = wall_samples(s_walls)
    sg = np.load(args.scan_grid)
    free_xy = sg["origin"] + (np.argwhere(sg["free"]) + 0.5) * float(sg["cell"])
    s_seen_xy = sg["origin"] + (np.argwhere(sg["free"] | sg["stock"]) + 0.5) * float(sg["cell"])
    mg = np.load(args.master_grid)
    m_seen = mg["free"] | mg["stock"]

    # Master wall map with a 0.15 m tolerance, padded so the new scan can sit partly outside.
    pad = 25.0
    origin = m_wall_xy.min(axis=0) - pad
    shape = tuple(np.ceil((m_wall_xy.max(axis=0) + pad - origin) / CELL).astype(int))
    m_img = ndimage.binary_dilation(raster(m_wall_xy, origin, shape), iterations=1).astype(np.float32)
    m_dist = ndimage.distance_transform_edt(m_img == 0) * CELL

    candidates = []
    centre = s_plan.mean(axis=0)
    for deg in range(0, 360, 1):
        R = rot(deg)
        w = (s_plan - centre) @ R.T
        lo = w.min(axis=0)
        k_shape = tuple(np.ceil((w.max(axis=0) - lo) / CELL).astype(int) + 1)
        k = raster(w, lo, k_shape)
        corr = signal.fftconvolve(m_img, k[::-1, ::-1], mode="valid")
        for flat in np.argsort(corr.ravel())[-3:]:
            i, j = np.unravel_index(flat, corr.shape)
            shift = origin + np.array([i, j]) * CELL - lo
            candidates.append((float(corr[i, j]) / k.sum(), deg, shift))
    candidates.sort(key=lambda c: -c[0])

    def evaluate(deg, shift):
        R = rot(deg)
        place = lambda xy: (xy - centre) @ R.T + shift
        plan = place(s_plan)
        idx = np.floor((plan - origin) / CELL).astype(int)
        overlap = float((m_dist[idx[:, 0], idx[:, 1]] <= 0.15).mean())
        fidx = np.floor((place(free_xy) - origin) / CELL).astype(int)
        conflict = float((m_dist[fidx[:, 0], fidx[:, 1]] <= 0.05).mean()) if len(fidx) else 0.0
        sidx = np.floor((place(s_seen_xy) - mg["origin"]) / float(mg["cell"])).astype(int)
        ok = (sidx >= 0).all(axis=1) & (sidx[:, 0] < m_seen.shape[0]) & (sidx[:, 1] < m_seen.shape[1])
        shared = float(m_seen[sidx[ok, 0], sidx[ok, 1]].sum() * float(sg["cell"]) ** 2)
        return overlap, conflict, shared

    # Distinct candidates (different place or angle), best first.
    distinct = []
    for score, deg, shift in candidates:
        if all(abs(((deg - d) + 180) % 360 - 180) > 5 or np.linalg.norm(shift - s) > 1.0 for _, d, s, *_ in distinct):
            overlap, conflict, shared = evaluate(deg, shift)
            distinct.append((score, deg, shift, overlap, conflict, shared))
        if len(distinct) >= 8:
            break

    tree = cKDTree(m_struct)
    results = []
    for score, deg, shift, overlap, conflict, shared in distinct:
        # ICP on structure points (x, y, height above floor), rotation about vertical only.
        R = rot(deg)
        src = s_struct.copy()
        src[:, :2] = (src[:, :2] - centre) @ R.T + shift
        total_R, total_t = np.eye(2), np.zeros(2)
        for _ in range(30):
            d, nn = tree.query(src, distance_upper_bound=0.5)
            ok = np.isfinite(d)
            if ok.sum() < 50:
                break
            a, b = src[ok, :2], m_struct[nn[ok], :2]
            ca, cb = a.mean(axis=0), b.mean(axis=0)
            u, _, vt = np.linalg.svd((a - ca).T @ (b - cb))
            r = (u @ vt).T
            if np.linalg.det(r) < 0:
                vt[-1] *= -1
                r = (u @ vt).T
            t = cb - ca @ r.T
            src[:, :2] = src[:, :2] @ r.T + t
            total_R, total_t = r @ total_R, r @ total_t + t
        d, _ = tree.query(src, distance_upper_bound=0.5)
        inl = np.isfinite(d)
        rms = float(np.sqrt(np.mean(d[inl] ** 2))) if inl.any() else float("inf")
        inlier_frac = float(inl.mean())
        final_R = total_R @ R
        final_t = total_R @ (shift - R @ centre) + total_t
        ang = math.degrees(math.atan2(final_R[1, 0], final_R[0, 0]))
        results.append({"corr": round(float(score), 3), "angle_deg": round(ang, 2), "shift_m": [round(float(v), 3) for v in final_t],
                        "plan_wall_overlap": round(overlap, 3), "open_floor_on_walls": round(conflict, 3),
                        "shared_area_m2": round(shared, 1), "icp_rms_m": round(rms, 3),
                        "icp_inlier_share": round(inlier_frac, 3),
                        "matrix": [[float(final_R[0, 0]), float(final_R[0, 1]), 0.0, float(final_t[0])],
                                   [float(final_R[1, 0]), float(final_R[1, 1]), 0.0, float(final_t[1])],
                                   [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]})
    best = results[0] if results else None
    runner = results[1] if len(results) > 1 else None
    accepted = bool(best and best["plan_wall_overlap"] >= 0.20 and best["icp_rms_m"] <= 0.05
                    and best["open_floor_on_walls"] <= 0.02
                    and (runner is None or best["corr"] - runner["corr"] >= 0.1))
    report = {"accepted": accepted, "candidates": results,
              "rule": "overlap >= 0.20, ICP RMS <= 0.05 m, open floor on walls <= 2 %, winner beats runner-up by >= 0.1"}
    pathlib.Path(args.out).write_text(json.dumps(report, indent=1))
    for r in results:
        print({k: v for k, v in r.items() if k != "matrix"})
    print("ACCEPTED" if accepted else "NOT ACCEPTED", "-", report["rule"])


if __name__ == "__main__":
    main()
