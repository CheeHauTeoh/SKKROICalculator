# Warehouse 3D capture and measurement

Measures the warehouse from a 3D capture and produces a metric Blender scene,
a floor plan and a measurement report for layout planning. Blender runs as the
`bpy` Python module, so no GUI is needed.

```
LiDAR scanner export (.e57 .las .laz) ─────────────┐
Phone LiDAR (Polycam etc: .ply .obj .glb) ─────────┤
Video/photos ─► marble_client.py ─► collider.glb ──┤  (+ taped reference distance)
                                                   ▼
                                     blender_measure.py ─► warehouse_scaled.blend
                                                           floor_plan.svg
                                                           report.md / report.json
```

Which input to use:

| Input | Scale | Accuracy | Notes |
|---|---|---|---|
| Matterport Pro3 / tripod scanner E57 | metres | ±20 mm @ 10 m (Matterport spec) | Best for planning |
| Handheld SLAM (BLK2GO, NavVis) E57/LAS | metres | ~10-20 mm, drifts on long walks | Close the loop when scanning |
| iPhone/iPad LiDAR (Polycam, Scaniverse) | metres | Drifts over large areas, ~5 m range | One bay or a small store |
| World Labs Marble (video) | needs calibration | Generative, not a survey | Concept layouts only |

## Setup

```bash
uv venv -p 3.13 .venv && source .venv/bin/activate   # bpy 5.2 ships wheels for Python 3.13
uv pip install -r warehouse3d/requirements.txt
```

## LiDAR scans

```bash
# Matterport Pro3 / Leica BLK / NavVis: export E57 (or LAS/LAZ)
python warehouse3d/blender_measure.py scan.e57 --out out/

# LAS stored in millimetres or feet
python warehouse3d/blender_measure.py scan.las --units mm --out out/

# Polycam / iPhone exports are usually Y-up
python warehouse3d/blender_measure.py polycam.ply --units m --up y --out out/
```

If the report warns that the ceiling is higher than the building is wide, the
up axis is wrong. Rerun with `--up y` (or `--up x`).

Useful options:
- `--obstacle-band 0.3 2.5`: the height range where anything blocks floor use.
  Pipes, beams and lights above it count toward clear height, not obstruction.
- `--rack-depth 2.6`: enclosed obstructions narrower than this are filled in
  (scanners only see the aisle faces of a rack row). Raise it for deeper racking.
- `--voxel 0.03`: downsampling. Raise it for very large E57 files.

## World Labs Marble (video or photos)

```bash
export WLT_API_KEY=...   # from https://platform.worldlabs.ai
python warehouse3d/marble_client.py --video walkthrough.mp4 --out out/ --dry-run
python warehouse3d/marble_client.py --video walkthrough.mp4 --out out/
# measure one distance in out/collider.glb with Blender's Measure tool, then:
python warehouse3d/blender_measure.py out/collider.glb --ref-model 3.71 --ref-real 10.0 --out out/
```

Marble fills in geometry it didn't see clearly. Check 3-5 distances on site.
The API field names come from the public docs and have not been tested against
the live API.

## Product layout and textured 3D model (Polycam exports)

From a Polycam LiDAR scan, export **LAZ** (point cloud), **DXF + CSV** (floor
plan) and **OBJ** (textured mesh), then:

```bash
# Floor plan zones, stock footprint, free floor, stack heights, stock volume
python warehouse3d/layout_map.py scan.laz --dxf floorplan.dxf --csv floorplan.csv --out out/

# Textured Blender scene with the roof cut away, zones overlaid, rendered views
python warehouse3d/build_blender_scene.py scan.obj --layout out/ --out out/
# If the textures were renamed (e.g. sent separately), let it match them by colour:
python warehouse3d/build_blender_scene.py scan.obj --images tex/*.jpg --scan scan.laz --layout out/ --out out/
```

`layout_map.py` writes `orthophoto.png` (true-colour top view, roof removed),
`stock_height.png`, `layout_report.md/json`, `zones.json` and `layout_grid.npz`.
`build_blender_scene.py` writes `warehouse_scan.blend`, plus `render_top.png` and
two cut-away views.

Stock means anything between 0.15 m and `--stock-cap` (default 3.3 m) above the
local floor. Higher points are treated as roof, and surfaces that carry on past
the cap are treated as walls or columns. That suits hand-stacked cartons and
pallets. In a racked warehouse, set `--stock-cap` just below the ceiling.

## Outputs

- `warehouse_scaled.blend`: metres, floor at z=0. Scans show as points, meshes as meshes.
- `floor_plan.svg`: top-down plan on a 5 m grid. Light is usable floor, dark is obstruction.
- `report.md` / `report.json`: footprint, floor area, obstructed and usable area,
  ceiling height, clear height under beams/pipes/lights, gross volume.

## Test without real data

```bash
python warehouse3d/make_test_scene.py test.e57              # also .las (--las-mm), .ply (--y-up), .glb
python warehouse3d/blender_measure.py test.e57 --out test_out/
```

The test warehouse is 40 x 25 m with a 10 m ceiling, two 30 x 1.2 x 6 m rack
rows, four columns and a pipe whose underside is at 6.85 m. Every format should
report a 40.3 x 25.3 m footprint (wall bases included), 10.0 m ceiling and
6.83-6.85 m clear height.

## Sources

- Matterport Pro3 accuracy: https://matterport.com/store/product/cam-mc300-x
- BLK2GO accuracy and drift: https://athena.westpoint.edu/items/b9bf4ec2-e574-4704-aec7-3a491886086d
- iPhone LiDAR range and drift: https://support.arcsite.com/en/articles/10593500-room-scanner,
  https://isprs-archives.copernicus.org/articles/XLVIII-2-2024/415/2024/
- Marble scale metadata: https://docs.worldlabs.ai/api/faq
