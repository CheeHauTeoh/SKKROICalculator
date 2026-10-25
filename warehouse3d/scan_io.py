"""Load warehouse scans and meshes as one metric, Z-up point array.

Supported inputs:
  .e57          Matterport Pro3, Leica BLK2GO / BLK360, NavVis, most tripod scanners
  .las / .laz   SLAM scanners and survey software exports
  .ply          Polycam / iPhone LiDAR / Scaniverse (point cloud or mesh)
  .obj .glb .gltf .fbx .stl   meshes (Polycam, Matterport OBJ, World Labs Marble)
"""

import math
import pathlib

import bpy
import numpy as np

UNIT_TO_M = {"m": 1.0, "cm": 0.01, "mm": 0.001, "ft": 0.3048, "in": 0.0254}
SCANNER_FORMATS = {".e57", ".las", ".laz"}
MESH_IMPORTERS = {
    ".obj": lambda p: bpy.ops.wm.obj_import(filepath=p),
    ".glb": lambda p: bpy.ops.import_scene.gltf(filepath=p),
    ".gltf": lambda p: bpy.ops.import_scene.gltf(filepath=p),
    ".fbx": lambda p: bpy.ops.import_scene.fbx(filepath=p),
    ".stl": lambda p: bpy.ops.wm.stl_import(filepath=p),
    ".ply": lambda p: bpy.ops.wm.ply_import(filepath=p),
}


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


def voxel_downsample(points, voxel):
    """Keep one point per `voxel`-sized cube."""
    if voxel <= 0 or len(points) == 0:
        return points
    keys = np.floor(points / voxel).astype(np.int64)
    _, first = np.unique(keys, axis=0, return_index=True)
    return points[np.sort(first)]


def to_z_up(points, up):
    """Rotate so the given axis becomes +Z (glTF/Polycam style Y-up -> Blender Z-up)."""
    if up == "z":
        return points
    if up == "y":
        return np.column_stack((points[:, 0], -points[:, 2], points[:, 1]))
    if up == "x":
        return np.column_stack((points[:, 1], points[:, 2], points[:, 0]))
    raise ValueError(f"Unknown up axis {up!r}")


def _read_e57(path):
    import pye57

    e57 = pye57.E57(str(path))
    chunks = []
    for index in range(e57.scan_count):
        scan = e57.read_scan(index, transform=True, ignore_missing_fields=True)
        chunks.append(np.column_stack((scan["cartesianX"], scan["cartesianY"], scan["cartesianZ"])))
    return np.concatenate(chunks)


def _read_las(path):
    import laspy

    las = laspy.read(str(path))
    return np.column_stack((las.x, las.y, las.z)).astype(np.float64)


def _import_mesh(path):
    """Import with Blender; returns (joined object, has_faces)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MESH_IMPORTERS[path.suffix.lower()](str(path))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit(f"No mesh or points found in {path}")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = "Scan"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj, len(obj.data.polygons) > 0


def mesh_points(obj, spacing):
    mesh = obj.data
    verts = np.empty(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", verts)
    verts = verts.reshape(-1, 3)
    if not len(mesh.polygons):
        return verts
    mesh.calc_loop_triangles()
    tris = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
    mesh.loop_triangles.foreach_get("vertices", tris)
    return sample_surface(verts[tris.reshape(-1, 3)], spacing)


def load_points(path, up="z", unit_scale=1.0, spacing=0.05):
    """Return (points in metres, Z-up) and the Blender mesh object if the input had faces.

    `unit_scale` is metres per file unit. `spacing` is the surface sampling
    distance for meshes, in metres.
    """
    path = pathlib.Path(path)
    suffix = path.suffix.lower()
    mesh_obj = None
    if suffix == ".e57":
        points = _read_e57(path)
    elif suffix in (".las", ".laz"):
        points = _read_las(path)
    elif suffix in MESH_IMPORTERS:
        obj, has_faces = _import_mesh(path)
        points = mesh_points(obj, spacing / unit_scale)
        if has_faces:
            mesh_obj = obj
        else:
            bpy.data.objects.remove(obj)
    else:
        raise SystemExit(f"Unsupported file type {suffix}")
    points = to_z_up(points[np.isfinite(points).all(axis=1)] * unit_scale, up)
    if mesh_obj is not None:
        _transform_object(mesh_obj, up, unit_scale)
    return points, mesh_obj


def _transform_object(obj, up, unit_scale):
    obj.scale = (unit_scale,) * 3
    if up == "y":
        obj.rotation_euler = (math.pi / 2, 0, 0)
    elif up == "x":
        obj.rotation_euler = (0, -math.pi / 2, -math.pi / 2)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def points_object(points, name="ScanPoints", max_points=2_000_000):
    """Add points to the scene as a mesh rendered through a Mesh to Points modifier."""
    if len(points) > max_points:
        points = points[np.random.default_rng(0).choice(len(points), max_points, replace=False)]
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(len(points))
    mesh.vertices.foreach_set("co", points.astype(np.float32).ravel())
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)

    group = bpy.data.node_groups.new("PointDisplay", "GeometryNodeTree")
    group.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    group.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    node_in = group.nodes.new("NodeGroupInput")
    node_out = group.nodes.new("NodeGroupOutput")
    to_points = group.nodes.new("GeometryNodeMeshToPoints")
    to_points.inputs["Radius"].default_value = 0.02
    group.links.new(node_in.outputs[0], to_points.inputs["Mesh"])
    group.links.new(to_points.outputs["Points"], node_out.inputs[0])
    obj.modifiers.new("Points", "NODES").node_group = group
    return obj
