"""Build a synthetic warehouse .glb with known dimensions to test blender_measure.py.

40 m x 25 m floor, 10 m ceiling, four 0.5 m columns and two 30 x 1.2 x 6 m rack
rows, exported at an arbitrary scale (default 0.4 units per metre) the way a
reconstruction without metric scale would be.

    python make_test_scene.py test.glb
    python blender_measure.py test.glb --ref-model 16 --ref-real 40 --out out/
"""

import argparse

import bpy


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out", nargs="?", default="test_warehouse.glb")
    parser.add_argument("--units", type=float, default=0.4, help="Model units per metre")
    args = parser.parse_args()
    u = args.units

    bpy.ops.wm.read_factory_settings(use_empty=True)
    plane("Floor", (40, 25), 0, u)
    plane("Ceiling", (40, 25), 10, u)
    box("WallS", (40, 0.2, 10), (20, -0.1, 5), u)
    box("WallN", (40, 0.2, 10), (20, 25.1, 5), u)
    box("WallW", (0.2, 25, 10), (-0.1, 12.5, 5), u)
    box("WallE", (0.2, 25, 10), (40.1, 12.5, 5), u)
    for i, (x, y) in enumerate([(10, 8), (30, 8), (10, 17), (30, 17)]):
        box(f"Column{i}", (0.5, 0.5, 10), (x, y, 5), u)
    box("RackA", (30, 1.2, 6), (20, 4, 3), u)
    box("RackB", (30, 1.2, 6), (20, 21, 3), u)
    bpy.ops.export_scene.gltf(filepath=args.out, export_format="GLB")
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
