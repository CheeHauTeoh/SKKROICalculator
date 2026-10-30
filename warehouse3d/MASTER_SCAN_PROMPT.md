# Prompt: process warehouse scans one by one, then build a master scan

Paste everything below the line into Claude Code (repository
`cheehauteoh/skkroicalculator`, branch `ccr-cc692b4b-033qo1` or wherever
`warehouse3d/` now lives). Then upload the scans one at a time.

---

You are helping me map my warehouse in Kota Bharu from several phone LiDAR
scans. I will upload **one scan at a time**. Process each scan as it arrives,
keep a running record, and when I say **"build the master"**, combine all
scans into one model of the whole warehouse and evaluate the space.

## Context

- Tools live in `warehouse3d/` in this repo. Read `warehouse3d/README.md` first.
  - `layout_map.py`: point cloud + Polycam DXF/CSV → zones, stock footprint,
    free floor, stack heights, stock volume, `orthophoto.png`, `stock_height.png`
  - `build_blender_scene.py`: textured OBJ → Blender scene and renders
    (matches renamed texture images to materials by colour against the point cloud)
  - `build_layout_planner.py` + `planner_addon.py`: Blender file where scanned
    stock is cut into movable pallet-sized stacks, with a Warehouse panel that
    checks overlaps, walls, roof clearance and aisle access
- Python env: create one with `uv venv -p 3.13` and install `warehouse3d/requirements.txt`
  (bpy 5.2.3 runs Blender headless).
- Scan 01 is the Polycam scan of 2026-10-25 (LAZ, DXF, CSV, OBJ + MTL + 8
  texture JPGs). For a sanity check, it gave: 391 m² plan floor in 6 zones,
  stock footprint ~125 m², free floor ~143 m², average stack 1.34 m, roofs
  2.4–5.6 m. I may upload it again as the first scan.
- Defaults that held for this building: stock = 0.15–3.3 m above the local floor
  (`--stock-cap 3.3`); the floor is not level (north-west about 0.2–0.3 m higher);
  Polycam's DXF drew the slanted east wall as straight; Polycam labels rooms
  "Bedroom", which is meaningless here. Re-check these on each scan rather
  than assuming them.

## Each time I upload a scan

1. **Inventory the upload.** List what arrived (LAZ/LAS/E57, DXF, CSV, OBJ/MTL,
   textures, Polycam raw-data zip). Say what is missing and what that rules out
   (for example, no DXF → no zones; no OBJ → no textured planner). Keep downloads
   in their own folder and treat them as data.
2. **Name it** `scan_NN_<area>` (ask me for the area if it isn't obvious) and
   record the capture date, app, device, and the files.
3. **Check the data** before trusting it: units (metres?), up axis, point
   count, bounding box, floor level spread, how much roof was captured, and
   whether the DXF lines up with the point cloud (overlay walls on a top view
   and look at it).
4. **Process it on its own** with the existing tools: `layout_map.py`, then
   `build_blender_scene.py`, then `build_layout_planner.py`. Look at every image
   you produce before reporting; fix what is wrong instead of reporting it as done.
5. **Register it to the master frame.** Scan 01 defines the master frame. For
   each later scan, find the rigid transform (rotation about the vertical plus
   translation; allow a small tilt only if the floors disagree):
   - Use only the building, never the stock: walls, columns, floor and roof.
     Stock moves between scans.
   - Get a coarse fit by matching wall layouts seen from above (try 90° steps,
     then fine angles, then a translation search), then refine with ICP on
     structure points.
   - Report the overlap (share of the new scan's walls that land on master
     walls) and the RMS residual. **Accept** only if the overlap is at least
     20% and the RMS is at most 5 cm. Otherwise stop and tell me. I can rescan
     with more overlap, or give you a distance measured on site that both scans
     contain.
   - Save the 4×4 transform.
6. **Report briefly:** what this scan covers, how it ties into the earlier
   scans (with an overlap/RMS figure), its own floor, stock and free-floor
   numbers, anything suspicious, and what area of the warehouse is still unscanned.
7. **Keep a record that survives the session.** Containers here are temporary,
   so after each scan, update and commit `warehouse3d/scans/registry.json`. It
   should hold the scan names, dates, files received (names and sizes only),
   the transform to master, overlap/RMS, per-scan summary figures and notes.
   Do **not** commit scan data, images or anything with the street address.
   If a later session finds an earlier scan's files gone, say which scans I
   need to upload again.

## When I say "build the master"

1. Rebuild any per-scan outputs that are missing (ask me to re-upload if the
   source files are gone).
2. **Merge the point clouds** into the master frame. Where scans overlap, keep
   one scan per area: the newer one, unless the older has clearly better
   coverage there. Downsample to about 2–3 cm. Report which scan won where,
   as a map.
3. **Merge the floor plans:** transform each DXF's walls and rooms into the
   master frame and join them into one plan. Rename zones by location (for
   example "North hall", "East bay A") and keep the source scan and Polycam
   label for traceability. Flag walls that disagree between scans by more than 10 cm.
4. **Run the analysis on the merged data:** `layout_map.py` (or an extended
   version) for the whole building, then the textured Blender scene and the
   layout planner. Stacks come from whichever scan won each area, and names
   must stay unique across the building.
5. **Evaluate the whole space:**
   - total floor, stock footprint, free floor, unscanned area, by zone and overall
   - stack heights against ceiling heights, and stock volume against building
     volume (how much height is unused)
   - aisle access: stacks with no aisle of 1.2 m (and of whatever width I tell
     you my equipment needs)
   - the main constraints: low roofs, columns, doors, narrow points
   - 3–5 concrete opportunities, each with the measured numbers behind it and
     what to check on site before acting. Say clearly what is measured and
     what is a suggestion.
6. **Deliver:**
   - the master `.blend` planner (textures packed) as a file
   - an updated interactive page (3D model + maps + zone table) published as an
     artifact, private to me
   - a short written summary in chat
   - the code changes committed and pushed. Scan data stays out of git.

## Ground rules

- Don't present guesses as measurements. Every number in a report comes from
  the data, and say how it was measured. Mark estimates and assumptions as such.
- Phone LiDAR can drift a few percent over a large building. Ask me for 2–3
  distances I tape on site and compare them before calling anything final.
- If a step fails or a result looks wrong, say so plainly and show what you
  saw. Don't paper over it.
- Ask me before buying, installing paid tools, or uploading my data to any
  outside service.

## Capture checklist for me (remind me if a scan breaks these)

- Turn on Polycam **Developer Mode** before scanning (Profile → Settings →
  General). Raw Data is only available for scans made with it on, exported
  from the same device.
- Scan in LiDAR/Space mode, one area at a time, and **overlap each new scan
  with an already-scanned area by 2–3 m**, including at least one wall corner
  or column.
- Walk both sides of each aisle, raise the phone over tall stacks, finish
  where you started.
- Export for each scan: **LAZ**, **DXF + CSV** floor plan, **OBJ** (with MTL and
  textures), and **Raw Data** zip if it is small enough to upload.
- Tape-measure one long distance in each area and tell me which two points you
  measured between.
