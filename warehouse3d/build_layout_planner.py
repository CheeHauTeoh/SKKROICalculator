"""Build an editable Blender layout planner from a warehouse scan.

Cuts the textured Polycam mesh into:
  - movable stock stacks: the scanned products, in pieces of about one pallet
    (1.2 x 1.0 m) each, so you can drag the real cartons and pallets around
  - the locked building: floor, walls and (hidden) roof
and adds the floor-plan zones, outlines of where everything stood when
scanned, a library of pallet stacks, racking, shelving and aisle gauges, and
the "Warehouse" sidebar panel (planner_addon.py) that checks a layout.

Needs the outputs of layout_map.py (--layout) and the same texture matching
as build_blender_scene.py.

Usage:
    python build_layout_planner.py scan.obj --images tex/*.jpg --scan scan.laz --layout out/ --out out/
"""

import argparse
import base64
import json
import math
import pathlib
import re

import bpy
import numpy as np
from scipy import ndimage

import build_blender_scene as scene_tools

HERE = pathlib.Path(__file__).resolve().parent
PALLET = (1.2, 1.0)   # metres; long side follows the long side of each block of stock
MIN_STACK_M2 = 0.15   # smaller scraps of stock stay part of the building


def ceiling_value(text):
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", str(text))]
    return min(nums) if nums else None


def load_layout(folder):
    folder = pathlib.Path(folder)
    grid = np.load(folder / "layout_grid.npz")
    zones = json.loads((folder / "zones.json").read_text())
    report = json.loads((folder / "layout_report.json").read_text())
    ceilings = {z["zone"]: ceiling_value(z["ceiling_height_m"]) for z in report["zones"]}
    for zone in zones["zones"]:
        zone["ceiling_m"] = ceilings.get(zone["id"])
    return grid, zones


def plan_tiles(grid):
    """Split stock into pallet-sized tiles. Returns per-cell tile id (-1 = none) and tile info."""
    stock, top, cell = grid["stock"], grid["top"], float(grid["cell"])
    labels, count = ndimage.label(stock, structure=np.ones((3, 3)))
    tile_id = np.full(stock.shape, -1, np.int32)
    tiles = []
    for comp, slices in enumerate(ndimage.find_objects(labels), start=1):
        sub = labels[slices] == comp
        wx, wy = sub.shape[0] * cell, sub.shape[1] * cell
        tx, ty = PALLET if wx >= wy else PALLET[::-1]
        ii, jj = np.nonzero(sub)
        ti = (ii * cell // tx).astype(int)
        tj = (jj * cell // ty).astype(int)
        for key in set(zip(ti, tj)):
            sel = (ti == key[0]) & (tj == key[1])
            if sel.sum() * cell * cell < MIN_STACK_M2:
                continue
            gi = ii[sel] + slices[0].start
            gj = jj[sel] + slices[1].start
            tile_id[gi, gj] = len(tiles)
            heights = top[gi, gj]
            lo = grid["origin"] + np.array([gi.min(), gj.min()]) * cell
            hi = grid["origin"] + (np.array([gi.max(), gj.max()]) + 1) * cell
            tiles.append({
                "centre": (lo + hi) / 2,
                "half": (hi - lo) / 2,
                "volume": float(heights.sum() * cell * cell),
                "height": float(np.percentile(heights, 90)),
                "area": float(len(gi) * cell * cell),
            })
    return tile_id, tiles


def wall_band(zones, grid, half_width):
    from shapely import contains_xy
    from shapely.geometry import LineString
    from shapely.ops import unary_union

    shape = grid["top"].shape
    cell = float(grid["cell"])
    lines = [LineString(w) for w in zones["walls"] if len(w) > 1]
    if not lines:
        return np.zeros(shape, bool)
    band = unary_union([l.buffer(half_width, cap_style="flat") for l in lines])
    xs = grid["origin"][0] + (np.arange(shape[0]) + 0.5) * cell
    ys = grid["origin"][1] + (np.arange(shape[1]) + 0.5) * cell
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    return contains_xy(band, gx, gy)


def zone_mask(zones, grid):
    from shapely import contains_xy
    from shapely.geometry import Polygon

    shape = grid["top"].shape
    cell = float(grid["cell"])
    xs = grid["origin"][0] + (np.arange(shape[0]) + 0.5) * cell
    ys = grid["origin"][1] + (np.arange(shape[1]) + 0.5) * cell
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    mask = np.zeros(shape, bool)
    for z in zones["zones"]:
        mask |= contains_xy(Polygon(z["polygon"]).buffer(0), gx, gy)
    return mask


def pack_bits(mask):
    return base64.b64encode(np.packbits(mask.astype(np.uint8).ravel()).tobytes()).decode()


def make_mesh(name, verts, uvs, faces_v, faces_t, faces_m, materials, origin, colours=None):
    """Mesh object from a subset of OBJ faces, positioned so its origin sits at `origin`.

    `colours` (uint8 RGB per OBJ vertex) adds a 'scan_rgb' attribute for parts without a texture.
    """
    used, remap = np.unique(faces_v, return_inverse=True)
    local = verts[used] - origin
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(len(local))
    mesh.vertices.foreach_set("co", local.astype(np.float32).ravel())
    n = len(faces_v)
    mesh.loops.add(n * 3)
    mesh.loops.foreach_set("vertex_index", remap.astype(np.int32).ravel())
    mesh.polygons.add(n)
    mesh.polygons.foreach_set("loop_start", np.arange(0, n * 3, 3, dtype=np.int32))
    mesh.polygons.foreach_set("loop_total", np.full(n, 3, np.int32))
    mesh.polygons.foreach_set("material_index", faces_m.astype(np.int32))
    uv_layer = mesh.uv_layers.new(name="UVMap")
    uv_layer.data.foreach_set("uv", uvs[faces_t.ravel()].astype(np.float32).ravel())
    mesh.update(calc_edges=True)
    mesh.validate()
    if colours is not None:
        scene_tools.add_colour_attribute(mesh, colours[used])
    for mat in materials:
        mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    obj.location = origin
    return obj


def collection(name, parent=None, hide=False, locked=False):
    col = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(col)
    col.hide_select = locked
    if hide:
        bpy.context.view_layer.layer_collection.children[name].hide_viewport = True
        col.hide_render = True
    return col


def colour_material(name, rgba):
    """Flat colour in both the viewport and renders."""
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = rgba
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = rgba
    out = nodes.new("ShaderNodeOutputMaterial")
    mat.node_tree.links.new(emit.outputs[0], out.inputs["Surface"])
    return mat


def box(name, size, location, mat, coll):
    """Cuboid with its origin at the centre of its base."""
    sx, sy, sz = size
    verts = [(x * sx / 2, y * sy / 2, z * sz) for z in (0, 1) for y in (-1, 1) for x in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    coll.objects.link(obj)
    return obj


def joined(name, parts, location, mat, coll):
    """One object from several (size, offset) cuboids; origin at base centre of the whole."""
    verts, faces = [], []
    for (sx, sy, sz), (ox, oy, oz) in parts:
        base = len(verts)
        verts += [(ox + x * sx / 2, oy + y * sy / 2, oz + z * sz) for z in (0, 1) for y in (-1, 1) for x in (-1, 1)]
        faces += [tuple(base + i for i in f) for f in
                  [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    coll.objects.link(obj)
    return obj


def lock_to_floor(obj):
    obj.lock_location[2] = True
    obj.lock_rotation[0] = obj.lock_rotation[1] = True


def build_library(coll, at):
    """Items to copy into the layout: pallet stack, racking, shelving, aisle gauges."""
    x, y = at
    items = []
    stack = box("Library: Pallet stack 1.5 m", (1.2, 1.0, 1.5), (x, y, 0),
                colour_material("Pallet stack", (0.96, 0.43, 0.26, 1)), coll)
    stack["wh_stack"], stack["wh_kind"] = True, "stack"
    items.append(stack)

    steel = colour_material("Rack steel", (0.15, 0.35, 0.75, 1))
    beam = colour_material("Rack beam", (0.95, 0.5, 0.1, 1))
    w, d, h = 2.7, 1.1, 4.0
    parts = [((0.08, 0.08, h), (sx * (w / 2 - 0.04), sy * (d / 2 - 0.04), 0)) for sx in (-1, 1) for sy in (-1, 1)]
    parts += [((w, 0.08, 0.12), (0, sy * (d / 2 - 0.04), lvl)) for sy in (-1, 1) for lvl in (1.4, 2.8)]
    rack = joined("Library: Pallet rack bay", parts, (x + 3.0, y, 0), steel, coll)
    rack.data.materials.append(beam)
    for poly in rack.data.polygons[24:]:
        poly.material_index = 1
    rack["wh_stack"], rack["wh_kind"], rack["wh_positions"] = True, "rack", 6
    rack["wh_note"] = "2.7 m x 1.1 m x 4.0 m, beams at 1.4 and 2.8 m: 3 levels x 2 pallets"
    items.append(rack)

    w, d, h = 1.8, 0.6, 2.4
    parts = [((0.04, 0.04, h), (sx * (w / 2 - 0.02), sy * (d / 2 - 0.02), 0)) for sx in (-1, 1) for sy in (-1, 1)]
    parts += [((w, d, 0.03), (0, 0, z)) for z in (0.1, 0.65, 1.2, 1.75, 2.3)]
    shelf = joined("Library: Shelving bay", parts, (x + 6.0, y, 0),
                   colour_material("Shelving", (0.2, 0.45, 0.8, 1)), coll)
    shelf["wh_stack"], shelf["wh_kind"], shelf["wh_positions"] = True, "shelving", 0
    shelf["wh_note"] = "1.8 m x 0.6 m x 2.4 m, 5 shelves"
    items.append(shelf)

    for i, width in enumerate((1.2, 2.0, 3.5)):
        gauge = box(f"Library: Aisle gauge {width:.1f} m", (width, 6.0, 0.02), (x + 9.0 + i * 4.0, y, 0),
                    colour_material(f"Aisle {width}", (0.2, 0.8, 0.45, 1)), coll)
        gauge["wh_kind"] = "gauge"
        items.append(gauge)

    for obj in items:
        obj["wh_library"] = True
        lock_to_floor(obj)
    return items


def setup_viewports(centre):
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            space = area.spaces.active
            space.shading.type = "SOLID"
            space.shading.color_type = "TEXTURE"
            space.shading.light = "FLAT"
            space.clip_end = 1000
            space.overlay.show_floor = True
            r3d = space.region_3d
            r3d.view_location = (centre[0], centre[1], 0)
            r3d.view_distance = 38
            r3d.view_rotation = (0.8660254, 0.5, 0.0, 0.0)  # tilted 60 deg from top, looking north
            r3d.view_perspective = "PERSP"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("obj")
    parser.add_argument("--images", nargs="*")
    parser.add_argument("--scan", help="Point cloud, to match --images to materials")
    parser.add_argument("--layout", required=True, help="layout_map.py output folder")
    parser.add_argument("--stock-cap", type=float, default=3.3)
    parser.add_argument("--out", default="out")
    args = parser.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    grid, zones = load_layout(args.layout)
    origin, cell = grid["origin"], float(grid["cell"])
    shape = grid["top"].shape
    floor_z = float(np.median(grid["floor"]))

    print("Matching textures…")
    textures = (scene_tools.match_textures(args.obj, args.scan, args.images) if args.images
                else scene_tools.textures_from_mtl(args.obj))
    if not textures:
        print("WARNING: no textures found; stacks will be plain grey. Pass --images and --scan if they were renamed.")
    verts, uvs, groups = scene_tools.read_obj_faces(args.obj)
    verts = verts - [0, 0, floor_z]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    missing = [name for name, _ in groups if name not in textures]
    # Parts whose texture image is missing take the colour of the nearest LiDAR point.
    colours = scene_tools.point_colours(verts + [0, 0, floor_z], args.scan) if missing and args.scan else None
    materials = [scene_tools.unlit_material(f"{name}_scan", textures[name]) if name in textures
                 else scene_tools.point_colour_material(f"{name}_pointcolour") if colours is not None
                 else colour_material(name, (0.7, 0.7, 0.7, 1)) for name, _ in groups]

    # All faces with their material.
    fv = np.concatenate([np.array(f)[:, :, 0] - 1 for _, f in groups])
    ft = np.concatenate([np.array(f)[:, :, 1] - 1 for _, f in groups])
    fm = np.concatenate([np.full(len(f), k) for k, (_, f) in enumerate(groups)])
    centre = verts[fv].mean(axis=1)
    ij = np.floor((centre[:, :2] - origin) / cell).astype(int)
    inside = (ij >= 0).all(axis=1) & (ij[:, 0] < shape[0]) & (ij[:, 1] < shape[1])
    ijc = np.clip(ij, 0, np.array(shape) - 1)
    local_floor = grid["floor"][ijc[:, 0], ijc[:, 1]] - floor_z
    h = centre[:, 2] - local_floor

    # Assign faces to stock tiles (reaching 0.2 m past the stock edge for stack sides).
    tile_id, tiles = plan_tiles(grid)
    walls = wall_band(zones, grid, 0.12)
    missing = tile_id < 0
    dist, (ni, nj) = ndimage.distance_transform_edt(missing, return_indices=True)
    reach = np.where(missing & (dist <= 2.0) & ~walls, tile_id[ni, nj], tile_id)
    face_tile = np.where(inside, reach[ijc[:, 0], ijc[:, 1]], -1)
    face_tile[(h < 0.06) | (h > args.stock_cap)] = -1
    roof = h > args.stock_cap
    print(f"{len(tiles)} stacks from {(face_tile >= 0).sum():,} of {len(fv):,} triangles")

    # Collections.
    building = collection("Scan: building", locked=True)
    roof_col = collection("Scan: roof", hide=True, locked=True)
    stock_col = collection("Stock and racking")
    ghosts = collection("As scanned (outlines)", hide=True, locked=True)
    plan_col = collection("Floor plan", locked=True)
    library = collection("Library (copy with the panel)")

    rest = face_tile < 0
    for name, sel, coll in (("Building scan", rest & ~roof, building), ("Roof scan", rest & roof, roof_col)):
        if sel.any():
            obj = make_mesh(name, verts, uvs, fv[sel], ft[sel], fm[sel], materials, np.zeros(3), colours)
            obj.color = (0.75, 0.77, 0.8, 1)
            coll.objects.link(obj)

    # Movable stacks, named by zone.
    zone_lookup = zone_index_grid(zones, grid)
    counters = {}
    order = np.argsort([(-t["centre"][1], t["centre"][0]) for t in tiles], axis=0)[:, 0]
    for t_index in order:
        sel = face_tile == t_index
        if not sel.any():
            continue
        tile = tiles[t_index]
        ci, cj = np.clip(np.floor((tile["centre"] - origin) / cell).astype(int), 0, np.array(shape) - 1)
        zone = zone_lookup[ci, cj] or "X"
        counters[zone] = counters.get(zone, 0) + 1
        name = f"Stack {zone}-{counters[zone]:02d}"
        obj = make_mesh(name, verts, uvs, fv[sel], ft[sel], fm[sel], materials,
                        np.array([tile["centre"][0], tile["centre"][1], 0.0]), colours)
        obj["wh_stack"], obj["wh_kind"] = True, "stack"
        obj["wh_volume"] = round(tile["volume"], 3)
        obj["wh_scanned_height"] = round(tile["height"], 2)
        hx, hy = tile["half"]
        obj["wh_footprint"] = [-hx, -hy, hx, hy]  # local metres; the mesh itself has ragged edges
        obj["wh_zone_scanned"] = zone
        obj.color = height_colour(tile["height"])
        lock_to_floor(obj)
        stock_col.objects.link(obj)
        ghost = bpy.data.objects.new(f"{name} (as scanned)", obj.data)
        ghost.location = obj.location
        ghost.display_type = "BOUNDS"
        ghost.color = (1, 1, 1, 1)
        ghosts.objects.link(ghost)

    # Floor plan: zone outlines and labels, plan walls.
    scene_tools.add_zones(pathlib.Path(args.layout) / "zones.json", 0.0)
    plan = bpy.data.collections.get("Floor plan.001") or bpy.data.collections.get("Floor plan")
    if plan is not None and plan != plan_col:
        for obj in list(plan.objects):
            plan_col.objects.link(obj)
            plan.objects.unlink(obj)
        bpy.data.collections.remove(plan)
    wall_mat = colour_material("Plan wall", (0.3, 0.33, 0.37, 1))
    for k, wall in enumerate(zones["walls"]):
        for a, b in zip(wall[:-1], wall[1:]):
            length = math.dist(a, b)
            if length < 0.05:
                continue
            obj = box(f"Plan wall {k}", (length, 0.1, 0.4), ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0), wall_mat, plan_col)
            obj.rotation_euler[2] = math.atan2(b[1] - a[1], b[0] - a[0])

    # Library south of the building.
    ys = verts[:, 1]
    build_library(library, (float(origin[0]) + 3.0, float(ys.min()) - 5.0))

    # Site data for the checks: usable floor, walls, zones with ceilings.
    usable = ndimage.binary_closing(grid["stock"] | grid["free"], iterations=2) | zone_mask(zones, grid)
    usable &= ~walls
    scene["wh_site"] = json.dumps({
        "origin": [float(v) for v in origin], "cell": cell, "shape": list(shape),
        "usable": pack_bits(usable), "walls": pack_bits(wall_band(zones, grid, 0.06)),
        "zones": [{"id": z["id"], "polygon": z["polygon"], "ceiling_m": z.get("ceiling_m")} for z in zones["zones"]],
    })
    scene["wh_site_version"] = 1

    # The planner panel, registered when the file opens.
    text = bpy.data.texts.new("warehouse_planner.py")
    text.from_string((HERE / "planner_addon.py").read_text())
    text.use_module = True

    scene.tool_settings.use_snap = False
    scene.tool_settings.snap_elements = {"INCREMENT"}
    scene.tool_settings.use_snap_grid_absolute = True
    setup_viewports(((origin[0] + origin[0] + shape[0] * cell) / 2, (origin[1] + origin[1] + shape[1] * cell) / 2 - 4))

    bpy.ops.file.pack_all()
    bpy.context.preferences.filepaths.save_version = 0
    path = (out / "warehouse_layout_planner.blend").resolve()
    bpy.ops.wm.save_as_mainfile(filepath=str(path), compress=True)
    print(f"Saved {path} with {sum(counters.values())} stacks")


def zone_index_grid(zones, grid):
    from shapely import contains_xy
    from shapely.geometry import Polygon

    shape = grid["top"].shape
    cell = float(grid["cell"])
    xs = grid["origin"][0] + (np.arange(shape[0]) + 0.5) * cell
    ys = grid["origin"][1] + (np.arange(shape[1]) + 0.5) * cell
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    out = np.full(shape, "", object)
    for z in zones["zones"]:
        out[(out == "") & contains_xy(Polygon(z["polygon"]).buffer(0), gx, gy)] = z["id"]
    return out


def height_colour(h):
    stops = [(0.0, (1.0, 0.88, 0.54)), (0.75, (0.99, 0.68, 0.38)), (1.5, (0.96, 0.43, 0.26)),
             (2.25, (0.84, 0.19, 0.15)), (3.0, (0.55, 0.04, 0.15))]
    for (h0, c0), (h1, c1) in zip(stops, stops[1:]):
        if h <= h1:
            t = max(0.0, (h - h0) / (h1 - h0))
            return tuple(a + t * (b - a) for a, b in zip(c0, c1)) + (1.0,)
    return stops[-1][1] + (1.0,)


if __name__ == "__main__":
    main()
