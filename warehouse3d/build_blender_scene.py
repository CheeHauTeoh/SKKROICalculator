"""Build a textured Blender scene of the warehouse scan and render views of it.

Takes a Polycam OBJ (+ its texture images), restores the right texture on each
part, and adds the floor-plan zones from layout_map.py. Saves a .blend and renders:
  render_top.png         top-down view with the roof cut away
  render_cutaway_*.png   angled views with the roof cut away

Polycam names its textures by hash (textures/<hash>.jpg). If the images were renamed
on the way (e.g. uploaded separately), pass them with --images and the point cloud
with --scan: each material gets the image whose colours match the point cloud there.

Usage:
    python build_blender_scene.py scan.obj --images img1.jpg img2.jpg ... --scan scan.laz \
        --layout out/ --out out/
"""

import argparse
import json
import math
import pathlib

import bpy
import numpy as np


def read_obj_faces(path):
    """Vertices (converted to Blender Z-up), UVs and per-material faces from an OBJ."""
    verts, uvs, groups = [], [], []
    with open(path) as handle:
        for line in handle:
            if line.startswith("v "):
                verts.append(line.split()[1:4])
            elif line.startswith("vt "):
                uvs.append(line.split()[1:3])
            elif line.startswith("usemtl"):
                groups.append((line.split()[1], []))
            elif line.startswith("f ") and groups:
                groups[-1][1].append([tuple(int(i) for i in c.split("/")[:2]) for c in line.split()[1:4]])
    v = np.array(verts, float)
    return np.column_stack((v[:, 0], -v[:, 2], v[:, 1])), np.array(uvs, float), groups


def match_textures(obj_path, scan_path, images, samples=4000, max_error=25.0):
    """Pick the image for each material whose colours best match the point cloud."""
    import laspy
    from PIL import Image
    from scipy.optimize import linear_sum_assignment
    from scipy.spatial import cKDTree

    Image.MAX_IMAGE_PIXELS = None
    verts, uvs, groups = read_obj_faces(obj_path)
    las = laspy.read(str(scan_path))
    points = np.column_stack((las.x, las.y, las.z))
    colours = np.column_stack((las.red, las.green, las.blue)) / (256.0 if np.max(las.red) > 255 else 1.0)
    tree = cKDTree(points)
    pixels = []
    for path in images:
        image = Image.open(path).convert("RGB")
        image = image.resize((1024, max(1, round(1024 * image.size[1] / image.size[0]))))
        pixels.append(np.asarray(image, float))

    rng = np.random.default_rng(0)
    cost = np.zeros((len(groups), len(images)))
    for gi, (_, faces) in enumerate(groups):
        faces = np.array(faces)
        faces = faces[rng.choice(len(faces), min(samples, len(faces)), replace=False)]
        centre = verts[faces[:, :, 0] - 1].mean(axis=1)
        uv = uvs[faces[:, :, 1] - 1].mean(axis=1)
        dist, idx = tree.query(centre)
        near = dist < 0.05
        for ii, img in enumerate(pixels):
            h, w = img.shape[:2]
            x = np.clip((uv[near, 0] * w).astype(int), 0, w - 1)
            y = np.clip(((1 - uv[near, 1]) * h).astype(int), 0, h - 1)
            cost[gi, ii] = np.abs(img[y, x] - colours[idx[near]]).mean()
    rows, cols = linear_sum_assignment(cost)
    result = {}
    for r, c in zip(rows, cols):
        others = np.delete(cost[r], c)
        runner_up = others.min() if len(others) else float("inf")
        # A true match sits far below the alternatives (~5-10 vs 60+). When images
        # are missing, the leftover materials only get weak matches: leave them untextured.
        if cost[r, c] > max_error or runner_up - cost[r, c] < 15:
            print(f"  {groups[r][0]}: no confident match (best {pathlib.Path(images[c]).name} at {cost[r, c]:.1f}, "
                  f"next {runner_up:.1f}) - left untextured")
            continue
        result[groups[r][0]] = str(images[c])
        print(f"  {groups[r][0]} -> {pathlib.Path(images[c]).name} (colour error {cost[r, c]:.1f}, next best {runner_up:.1f})")
    missing = [name for name, _ in groups if name not in result]
    if missing:
        print(f"  No texture for {', '.join(missing)}")
    return result


def textures_from_mtl(obj_path):
    """Material -> texture image from the OBJ's own MTL file (when the textures kept their names)."""
    obj_path = pathlib.Path(obj_path)
    textures = {}
    for line in obj_path.read_text().splitlines()[:50]:
        if line.startswith("mtllib"):
            mtl = obj_path.parent / line.split(maxsplit=1)[1].strip()
            if not mtl.exists():
                return textures
            current = None
            for row in mtl.read_text().splitlines():
                if row.startswith("newmtl"):
                    current = row.split(maxsplit=1)[1].strip()
                elif row.startswith("map_Kd") and current:
                    image = mtl.parent / row.split(maxsplit=1)[1].strip()
                    if image.exists():
                        textures[current] = str(image)
            break
    return textures


def unlit_material(name, image_path):
    """Show the scan's captured colours as-is (the texture already contains the lighting)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(str(image_path))
    emit = nodes.new("ShaderNodeEmission")
    out = nodes.new("ShaderNodeOutputMaterial")
    links.new(tex.outputs["Color"], emit.inputs["Color"])
    links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


def grey_material(name):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (0.59, 0.6, 0.61, 1)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (0.59, 0.6, 0.61, 1)
    out = nodes.new("ShaderNodeOutputMaterial")
    mat.node_tree.links.new(emit.outputs[0], out.inputs["Surface"])
    return mat


def point_colours(xyz, laz):
    """Colour of the nearest LiDAR point for each vertex (uint8 RGB), for mesh parts without a texture."""
    import laspy
    from scipy.spatial import cKDTree

    las = laspy.read(str(laz))
    pts = np.column_stack((las.x, las.y, las.z))
    rgb = np.column_stack((las.red, las.green, las.blue)).astype(np.float64)
    rgb = (rgb / (256.0 if rgb.max() > 255 else 1.0)).clip(0, 255).astype(np.uint8)
    _, idx = cKDTree(pts).query(xyz, k=1)
    return rgb[idx]


def add_colour_attribute(mesh, rgb):
    """Per-vertex 'scan_rgb' colour attribute from uint8 RGB."""
    attr = mesh.color_attributes.new("scan_rgb", "BYTE_COLOR", "POINT")
    rgba = np.column_stack((rgb / 255.0, np.ones(len(rgb)))).astype(np.float32)
    attr.data.foreach_set("color_srgb", rgba.ravel())


def point_colour_material(name):
    """Shows the 'scan_rgb' attribute unlit (texture image missing; colours come from the point cloud)."""
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (0.59, 0.6, 0.61, 1)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    attr = nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "scan_rgb"
    emit = nodes.new("ShaderNodeEmission")
    out = nodes.new("ShaderNodeOutputMaterial")
    mat.node_tree.links.new(attr.outputs["Color"], emit.inputs["Color"])
    mat.node_tree.links.new(emit.outputs[0], out.inputs["Surface"])
    return mat


def import_scan(obj_path, textures, laz=None):
    bpy.ops.wm.obj_import(filepath=str(obj_path))  # Y-up OBJ -> Blender Z-up
    objects = [o for o in bpy.context.selected_objects if o.type == "MESH"]
    for obj in objects:
        for slot in obj.material_slots:
            base = slot.material.name.split(".")[0] if slot.material else None
            if base in textures:
                slot.material = unlit_material(f"{base}_scan", textures[base])
            elif slot.material:
                # Texture image not supplied: colour from the point cloud if we have it, else plain grey
                # (instead of Blender's missing-image pink).
                slot.material = point_colour_material(f"{base}_pointcolour") if laz else grey_material(f"{base}_untextured")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    # The importer stores the Y-up -> Z-up turn as an object rotation; bake it into the vertices.
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    scan = bpy.context.view_layer.objects.active
    scan.name = "Scan (full)"
    if laz and any(m and m.name.endswith("_pointcolour") for m in scan.data.materials):
        xyz = np.empty(len(scan.data.vertices) * 3)
        scan.data.vertices.foreach_get("co", xyz)
        add_colour_attribute(scan.data, point_colours(xyz.reshape(-1, 3), laz))
    return scan


def roof_cut_copy(scan, cut_z):
    """Duplicate of the scan with everything above cut_z removed."""
    import bmesh

    cut = scan.copy()
    cut.data = scan.data.copy()
    cut.name = "Scan (roof removed)"
    bpy.context.scene.collection.objects.link(cut)
    bm = bmesh.new()
    bm.from_mesh(cut.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z > cut_z], context="VERTS")
    bm.to_mesh(cut.data)
    bm.free()
    return cut


def add_zones(zones_path, floor_z):
    data = json.loads(pathlib.Path(zones_path).read_text())
    collection = bpy.data.collections.new("Floor plan")
    bpy.context.scene.collection.children.link(collection)
    line_mat = bpy.data.materials.new("Zone outline")
    line_mat.use_nodes = True
    emit = line_mat.node_tree.nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (0.05, 0.35, 0.9, 1)
    emit.inputs["Strength"].default_value = 2.0
    line_mat.node_tree.links.new(emit.outputs[0], line_mat.node_tree.nodes["Material Output"].inputs["Surface"])
    for zone in data["zones"]:
        curve = bpy.data.curves.new(f"Zone {zone['id']}", "CURVE")
        curve.dimensions = "3D"
        curve.bevel_depth = 0.04
        spline = curve.splines.new("POLY")
        pts = zone["polygon"]
        spline.points.add(len(pts) - 1)
        for p, (x, y) in zip(spline.points, pts):
            p.co = (x, y, floor_z + 0.05, 1)
        spline.use_cyclic_u = True
        obj = bpy.data.objects.new(f"Zone {zone['id']} ({zone['polycam_name']})", curve)
        obj.data.materials.append(line_mat)
        collection.objects.link(obj)

        text = bpy.data.curves.new(f"Label {zone['id']}", "FONT")
        text.body = f"Zone {zone['id']}"
        text.size = 0.8
        text.align_x = text.align_y = "CENTER"
        label = bpy.data.objects.new(f"Label {zone['id']}", text)
        xs, ys = zip(*pts)
        label.location = (sum(xs) / len(xs), sum(ys) / len(ys), floor_z + 3.6)
        label.data.materials.append(line_mat)
        collection.objects.link(label)


def add_camera(name, location, target, ortho_scale=None, clip_start=0.1):
    cam = bpy.data.cameras.new(name)
    if ortho_scale:
        cam.type = "ORTHO"
        cam.ortho_scale = ortho_scale
    else:
        cam.lens = 24
    cam.clip_start = clip_start
    cam.clip_end = 200
    obj = bpy.data.objects.new(name, cam)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    direction = np.subtract(target, location)
    if math.hypot(direction[0], direction[1]) < 1e-6:
        obj.rotation_euler = (0, 0, 0)  # straight down, north up
    else:
        obj.rotation_euler = (math.atan2(math.hypot(direction[0], direction[1]), -direction[2]), 0,
                              math.atan2(direction[1], direction[0]) - math.pi / 2)
    return obj


def render(camera, path, resolution, samples):
    scene = bpy.context.scene
    scene.camera = camera
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("White")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    scene.world = world
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("obj", help="Polycam OBJ export")
    parser.add_argument("--images", nargs="*", help="Texture images, if not in the OBJ's textures/ folder")
    parser.add_argument("--scan", help="Point cloud used to match --images to materials")
    parser.add_argument("--layout", help="layout_map.py output folder (zones.json, layout_grid.npz)")
    parser.add_argument("--stock-cap", type=float, default=3.3, help="Cut the roof this high above the floor")
    parser.add_argument("--samples", type=int, default=16)
    parser.add_argument("--no-render", action="store_true")
    parser.add_argument("--out", default="out")
    args = parser.parse_args()

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    if args.images:
        if not args.scan:
            parser.error("--images needs --scan to work out which image goes where")
        print("Matching textures to materials:")
        textures = match_textures(args.obj, args.scan, args.images)
    else:
        textures = textures_from_mtl(args.obj)
    scan = import_scan(args.obj, textures, laz=args.scan)

    floor_z = float(np.median(np.load(pathlib.Path(args.layout) / "layout_grid.npz")["floor"])) \
        if args.layout else float(np.percentile([v.co.z for v in scan.data.vertices], 1))
    cut = roof_cut_copy(scan, floor_z + args.stock_cap)
    scan.hide_render = True
    scan.hide_set(True)
    if args.layout:
        add_zones(pathlib.Path(args.layout) / "zones.json", floor_z)

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"

    xs = [v.co.x for v in cut.data.vertices]
    ys = [v.co.y for v in cut.data.vertices]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    span = max(max(xs) - min(xs), (max(ys) - min(ys)) * 16 / 9) * 1.04
    reach = max(0.35, math.hypot(max(xs) - min(xs), max(ys) - min(ys)) / 40.0)
    top = add_camera("Top view", (cx, cy, floor_z + 30), (cx, cy, floor_z), ortho_scale=span)
    views = {
        # 22 m out and 16 m up suits the 37 m baseline building; scale with the scan's size.
        "south_west": add_camera("Cutaway SW", (cx - 22 * reach, cy - 22 * reach, floor_z + 16 * reach), (cx, cy, floor_z)),
        "north_east": add_camera("Cutaway NE", (cx + 22 * reach, cy + 22 * reach, floor_z + 16 * reach), (cx, cy, floor_z)),
    }

    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str((out / "warehouse_scan.blend").resolve()))
    if not args.no_render:
        render(top, out / "render_top.png", (2400, 1350), args.samples)
        for name, cam in views.items():
            render(cam, out / f"render_cutaway_{name}.png", (1920, 1080), args.samples)
    print(f"Saved {out / 'warehouse_scan.blend'}")


if __name__ == "__main__":
    main()
