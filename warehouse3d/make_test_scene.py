"""Build a synthetic warehouse with known dimensions to test blender_measure.py.

40 m x 25 m floor, 10 m ceiling, four 0.5 m columns, two 30 x 1.2 x 6 m rack
rows and a pipe run hanging at 7 m (so clear height is ~6.9 m).

    python make_test_scene.py test.glb                 # mesh at 0.4 units/m, like an unscaled reconstruction
    python make_test_scene.py test.e57                 # scanner-like point cloud in metres
    python make_test_scene.py test.las --las-mm        # point cloud stored in millimetres
    python make_test_scene.py test.ply --y-up          # Polycam-style Y-up point cloud
"""

import argparse
import pathlib

import bpy
import numpy as np

import scan_io


def box(name, size, centre, units):
    bpy.ops.mesh.primitive_cube_add(size=1, location=[c * units for c in centre])
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = [s * units for s in size]
    return obj


def plane(name, size, z, units):
    bpy.ops.mesh.primitive_plane_add(size=1, location=(20 * units, 12.5 * units, z * units))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0] * units, size[1] * units, 1)
    return obj


def build(units):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    plane("Floor", (40, 25), 0, units)
    plane("Ceiling", (40, 25), 10, units)
    box("WallS", (40, 0.2, 10), (20, -0.1, 5), units)
    box("WallN", (40, 0.2, 10), (20, 25.1, 5), units)
    box("WallW", (0.2, 25, 10), (-0.1, 12.5, 5), units)
    box("WallE", (0.2, 25, 10), (40.1, 12.5, 5), units)
    for i, (x, y) in enumerate([(10, 8), (30, 8), (10, 17), (30, 17)]):
        box(f"Column{i}", (0.5, 0.5, 10), (x, y, 5), units)
    box("RackA", (30, 1.2, 6), (20, 4, 3), units)
    box("RackB", (30, 1.2, 6), (20, 21, 3), units)
    box("Pipe", (40, 0.3, 0.3), (20, 12.5, 7.0), units)


def scene_points(spacing=0.06, seed=0):
    """Scanner-like cloud: surface samples, 5 mm noise, shadows under racks, stray points."""
    rng = np.random.default_rng(seed)
    bpy.context.view_layer.update()  # matrix_world is stale for the last object added
    chunks = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        mesh.calc_loop_triangles()
        verts = np.array([obj.matrix_world @ v.co for v in mesh.vertices])
        tris = np.array([t.vertices[:] for t in mesh.loop_triangles])
        chunks.append(scan_io.sample_surface(verts[tris], spacing))
    points = np.concatenate(chunks)
    under_rack = (points[:, 2] < 0.01) & (np.abs(points[:, 0] - 20) < 15) & (
        (np.abs(points[:, 1] - 4) < 0.6) | (np.abs(points[:, 1] - 21) < 0.6))
    points = points[~under_rack]
    points += rng.normal(0, 0.005, points.shape)
    strays = rng.uniform([0, 0, 0], [40, 25, 10], (500, 3))
    return np.concatenate((points, strays))


def write_points(points, path, las_mm, y_up):
    suffix = path.suffix.lower()
    if suffix == ".e57":
        import pye57

        e57 = pye57.E57(str(path), mode="w")
        e57.write_scan_raw({"cartesianX": points[:, 0], "cartesianY": points[:, 1], "cartesianZ": points[:, 2]})
        e57.close()
    elif suffix in (".las", ".laz"):
        import laspy

        factor = 1000.0 if las_mm else 1.0
        header = laspy.LasHeader(point_format=3, version="1.2")
        header.scales = np.array([0.001, 0.001, 0.001]) * factor
        header.offsets = np.zeros(3)
        las = laspy.LasData(header)
        las.x, las.y, las.z = (points * factor).T
        las.write(str(path))
    elif suffix == ".ply":
        if y_up:  # Z-up -> Y-up, the inverse of scan_io.to_z_up(..., "y")
            points = np.column_stack((points[:, 0], points[:, 2], -points[:, 1]))
        header = f"ply\nformat ascii 1.0\nelement vertex {len(points)}\nproperty float x\nproperty float y\nproperty float z\nend_header\n"
        with open(path, "w") as handle:
            handle.write(header)
            np.savetxt(handle, points, fmt="%.4f")
    else:
        raise SystemExit(f"Unsupported point format {suffix}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", nargs="?", default="test_warehouse.glb")
    parser.add_argument("--units", type=float, default=0.4, help="Model units per metre (.glb only)")
    parser.add_argument("--las-mm", action="store_true", help="Store LAS coordinates in millimetres")
    parser.add_argument("--y-up", action="store_true", help="Write the PLY with Y as the up axis")
    args = parser.parse_args()
    path = pathlib.Path(args.out)

    if path.suffix.lower() in (".glb", ".gltf"):
        build(args.units)
        bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB")
    else:
        build(1.0)
        write_points(scene_points(), path, args.las_mm, args.y_up)
    print(f"Wrote {path}")


if __name__ == "__main__":
    main()
