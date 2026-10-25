# Warehouse 3D reconstruction and measurement

Turns a walkthrough video or photos of the warehouse into a 3D world with the
[World Labs Marble API](https://docs.worldlabs.ai/api), then scales and measures
it in Blender (run as the `bpy` Python module, no GUI needed).

```
video / photos ──► marble_client.py ──► collider.glb + world.json
                                              │
                    tape / laser reference ──►│
                                              ▼
                                   blender_measure.py ──► warehouse_scaled.blend
                                                          floor_plan.svg
                                                          report.json / report.md
```

## Setup

```bash
uv venv -p 3.13 .venv && source .venv/bin/activate   # bpy 5.2 ships wheels for Python 3.13
uv pip install -r warehouse3d/requirements.txt
export WLT_API_KEY=...   # from https://platform.worldlabs.ai
```

## 1. Capture

- One slow, steady walkthrough video, under 100 MB, covering every wall and aisle.
- Before filming, measure 2-3 long distances on site (wall to wall, column to
  column) with a laser meter. You need at least one to set the scale.

## 2. Generate the world

```bash
python warehouse3d/marble_client.py --video walkthrough.mp4 --out out/ --dry-run   # check the request
python warehouse3d/marble_client.py --video walkthrough.mp4 --out out/
```

Saves `out/world.json` (all asset URLs plus `metric_scale_factor`) and
`out/collider.glb`.

## 3. Calibrate and measure

Open `out/collider.glb` in Blender, measure the same distance you taped on site
(Measure tool), then:

```bash
python warehouse3d/blender_measure.py out/collider.glb --ref-model 3.71 --ref-real 10.0 --out out/
```

Or try Marble's own scale with `--world-json out/world.json`, then check it
against a taped distance.

Outputs:
- `warehouse_scaled.blend`: metric units, floor at z=0. Use it for racking layout in Blender.
- `floor_plan.svg`: top-down plan. Light is usable floor, dark is obstruction, on a 5 m grid.
- `report.md` / `report.json`: footprint, floor area, obstructed and usable area,
  ceiling height, gross volume.

## Test without the API

```bash
python warehouse3d/make_test_scene.py test.glb          # 40 x 25 m, 10 m ceiling, built at 0.4 units/m
python warehouse3d/blender_measure.py test.glb --ref-model 16 --ref-real 40 --out test_out/
```

Expected result: about 40.3 x 25.3 m footprint (the wall bases add width),
10.0 m ceiling, and racks plus columns shown as obstructions.

## Limits

- **Marble is generative.** It fills in geometry the camera didn't see clearly,
  so it is not a survey. Always check 3-5 distances on site before committing to
  racking orders.
- **Scale:** the FAQ says splats come in arbitrary units and you multiply by
  `metric_scale_factor` ([FAQ](https://docs.worldlabs.ai/api/faq)). One
  third-party project says the collider mesh is already metric
  ([worldspec](https://github.com/3-rt/worldspec)). That's why a taped reference
  distance is the default calibration.
- The API request and response field names were taken from the public docs but
  have not yet been tested against the live API. Run `--dry-run` first.
