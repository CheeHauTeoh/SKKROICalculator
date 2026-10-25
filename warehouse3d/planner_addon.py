"""Warehouse layout planner panel (runs inside Blender).

build_layout_planner.py stores this file in the .blend as a text block that
registers itself when the file opens (allow scripts when Blender asks, or open
the Scripting tab and press Run Script). It adds a "Warehouse" tab to the 3D
view sidebar (press N) that checks the layout you build:

  - stock that overlaps other stock or a wall, or sits off the usable floor
  - stacks that come within the roof clearance of the ceiling
  - stacks with no aisle of the chosen width beside them
  - footprint, volume and pallet positions, overall and per zone

Objects with the custom property "wh_stack" are stock or racking; everything
in the "Building" and "Scan reference" collections is locked reference.
"""

import base64
import json
import math

import bpy
import numpy as np

RESULTS = {}


# ----------------------------------------------------------------------------
# Grid helpers (the building, zones and usable floor are stored on the scene)

def site(scene):
    cache = RESULTS.get("_site")
    if cache and cache["key"] == scene.get("wh_site_version"):
        return cache
    data = json.loads(scene["wh_site"])
    shape = tuple(data["shape"])

    def bits(name):
        raw = np.frombuffer(base64.b64decode(data[name]), np.uint8)
        return np.unpackbits(raw)[: shape[0] * shape[1]].reshape(shape).astype(bool)

    cache = {
        "key": scene.get("wh_site_version"),
        "origin": np.array(data["origin"], float),
        "cell": float(data["cell"]),
        "shape": shape,
        "usable": bits("usable"),
        "walls": bits("walls"),
        "zones": data["zones"],
    }
    cache["zone_index"] = zone_index(cache)
    RESULTS["_site"] = cache
    return cache


def point_in_poly(x, y, poly):
    inside = np.zeros(np.shape(x), bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        crosses = ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1)
        inside ^= crosses
    return inside


def cell_centres(s, i0=0, i1=None, j0=0, j1=None):
    i1 = s["shape"][0] if i1 is None else i1
    j1 = s["shape"][1] if j1 is None else j1
    xs = s["origin"][0] + (np.arange(i0, i1) + 0.5) * s["cell"]
    ys = s["origin"][1] + (np.arange(j0, j1) + 0.5) * s["cell"]
    return np.meshgrid(xs, ys, indexing="ij")


def zone_index(s):
    """Zone number (0 = none) for every grid cell."""
    gx, gy = cell_centres(s)
    idx = np.zeros(s["shape"], np.int16)
    for k, zone in enumerate(s["zones"], start=1):
        idx[(idx == 0) & point_in_poly(gx, gy, zone["polygon"])] = k
    return idx


def footprint(obj):
    """World-space bottom rectangle (4 xy corners) and top height of an object.

    Scanned stacks carry their pallet footprint and stack height from the scan,
    because the scanned mesh has ragged edges; anything else uses its bounding box.
    """
    from mathutils import Vector

    if "wh_footprint" in obj:
        x0, y0, x1, y1 = obj["wh_footprint"]
        pts = np.array([(c.x, c.y) for c in (obj.matrix_world @ Vector((x, y, 0)) for x, y in
                                             ((x0, y0), (x1, y0), (x1, y1), (x0, y1)))])
        return pts, float(obj.get("wh_scanned_height", obj.dimensions.z)) * obj.scale.z
    corners = [obj.matrix_world @ __import__("mathutils").Vector(c) for c in obj.bound_box]
    zs = [c.z for c in corners]
    bottom = sorted(corners, key=lambda c: c.z)[:4]
    pts = np.array([(c.x, c.y) for c in bottom])
    centre = pts.mean(axis=0)
    order = np.argsort(np.arctan2(pts[:, 1] - centre[1], pts[:, 0] - centre[0]))
    return pts[order], max(zs)


def raster(s, poly):
    """Grid cells whose centres fall inside a convex polygon: (i0, j0, mask)."""
    lo = np.floor((poly.min(axis=0) - s["origin"]) / s["cell"]).astype(int)
    hi = np.ceil((poly.max(axis=0) - s["origin"]) / s["cell"]).astype(int)
    i0, j0 = max(lo[0], 0), max(lo[1], 0)
    i1, j1 = min(hi[0], s["shape"][0]), min(hi[1], s["shape"][1])
    if i1 <= i0 or j1 <= j0:
        return i0, j0, np.zeros((0, 0), bool), True
    gx, gy = cell_centres(s, i0, i1, j0, j1)
    mask = point_in_poly(gx, gy, poly)
    outside_grid = lo[0] < 0 or lo[1] < 0 or hi[0] > s["shape"][0] or hi[1] > s["shape"][1]
    return i0, j0, mask, outside_grid


def shift_or(mask, di, dj):
    out = np.zeros_like(mask)
    h, w = mask.shape
    out[max(di, 0): h + min(di, 0), max(dj, 0): w + min(dj, 0)] = \
        mask[max(-di, 0): h + min(-di, 0), max(-dj, 0): w + min(-dj, 0)]
    return out


def erode(mask, r):
    out = mask.copy()
    for di in range(-r, r + 1):
        for dj in range(-r, r + 1):
            if di * di + dj * dj <= r * r:
                out &= shift_or(mask, di, dj)
    return out


def dilate(mask, r):
    out = mask.copy()
    for di in range(-r, r + 1):
        for dj in range(-r, r + 1):
            if di * di + dj * dj <= r * r:
                out |= shift_or(mask, di, dj)
    return out


# ----------------------------------------------------------------------------
# The check

def stack_volume(obj):
    """Scanned stock volume, scaled if the stack was resized; a box for new stacks."""
    scale = obj.scale.x * obj.scale.y * obj.scale.z
    if "wh_volume" in obj:
        return float(obj["wh_volume"]) * scale
    d = obj.dimensions
    return float(d.x * d.y * d.z)


def stock_objects(scene):
    return [o for o in scene.objects if o.get("wh_stack") and not o.get("wh_library") and o.visible_get()]


def check_layout(scene):
    s = site(scene)
    props = scene.wh_settings
    cell = s["cell"]
    area = cell * cell
    owner = np.full(s["shape"], -1, np.int32)
    overlap = np.zeros(s["shape"], bool)
    objs = stock_objects(scene)
    issues = {}
    info = []

    def flag(obj, text):
        issues.setdefault(obj.name, []).append(text)

    for n, obj in enumerate(objs):
        poly, top = footprint(obj)
        i0, j0, mask, off_grid = raster(s, poly)
        sl = (slice(i0, i0 + mask.shape[0]), slice(j0, j0 + mask.shape[1]))
        cells = mask.sum()
        hit = mask & (owner[sl] >= 0)
        if hit.any():
            overlap[sl] |= hit
            for other in np.unique(owner[sl][hit]):
                flag(obj, f"overlaps {objs[other].name}")
                flag(objs[other], f"overlaps {obj.name}")
        owner[sl][mask] = n
        if (mask & s["walls"][sl]).any():
            flag(obj, "hits a wall")
        if off_grid or (cells and (mask & ~s["usable"][sl]).sum() > 0.2 * cells):
            flag(obj, "off the usable floor")
        zones = s["zone_index"][sl][mask]
        zone = int(np.bincount(zones).argmax()) if len(zones) else 0
        ceiling = s["zones"][zone - 1]["ceiling_m"] if zone else None
        if ceiling and top > ceiling - props.roof_clearance:
            flag(obj, f"top {top:.2f} m is within {props.roof_clearance:.1f} m of the {ceiling:.1f} m ceiling")
        kind = obj.get("wh_kind", "stack")
        dims = obj.dimensions
        info.append({"obj": obj, "zone": zone, "cells": int(cells), "top": top, "kind": kind,
                     "volume": stack_volume(obj) if kind == "stack" else 0.0,
                     "positions": int(obj.get("wh_positions", 1)), "sl": sl, "mask": mask})

    # Aisles: free usable floor wide enough to fit a circle of the aisle width.
    occupied = owner >= 0
    free = s["usable"] & ~occupied & ~s["walls"]
    r = max(1, int(props.aisle_width / 2 / cell - 0.5))  # circle just inside the aisle width
    aisle = dilate(erode(free, r), r) & free
    # A stack is reachable when an aisle runs within 0.2 m of its footprint.
    reach = dilate(aisle, 2)
    for item in info:
        sl, mask = item["sl"], item["mask"]
        if mask.size and not (mask & reach[sl]).any():
            flag(item["obj"], f"no {props.aisle_width:.1f} m aisle beside it")

    zones_out = []
    for k, zone in enumerate(s["zones"], start=1):
        zmask = s["zone_index"] == k
        items = [i for i in info if i["zone"] == k]
        zones_out.append({
            "id": zone["id"],
            "floor": float((zmask & s["usable"]).sum() * area),
            "stock": float((occupied & zmask).sum() * area),
            "free": float((free & zmask).sum() * area),
            "volume": sum(i["volume"] for i in items),
            "positions": sum(i["positions"] for i in items if i["kind"] != "stack"),
            "count": len(items),
        })
    usable = float(s["usable"].sum() * area)
    RESULTS.update({
        "checked": True,
        "count": len(objs),
        "stacks": sum(1 for i in info if i["kind"] == "stack"),
        "racks": sum(1 for i in info if i["kind"] != "stack"),
        "positions": sum(i["positions"] for i in info if i["kind"] != "stack"),
        "footprint": float(occupied.sum() * area),
        "volume": sum(i["volume"] for i in info),
        "usable": usable,
        "free": float(free.sum() * area),
        "aisle": float(aisle.sum() * area),
        "zones": zones_out,
        "issues": issues,
    })
    return RESULTS


# ----------------------------------------------------------------------------
# UI

class WH_Settings(bpy.types.PropertyGroup):
    aisle_width: bpy.props.FloatProperty(name="Aisle width", default=1.2, min=0.5, max=5.0, step=10, unit="LENGTH",
                                         description="Narrowest aisle a stack must face (trolley ~1.2 m; check your pallet truck or forklift spec)")
    roof_clearance: bpy.props.FloatProperty(name="Roof clearance", default=0.5, min=0.0, max=3.0, step=10, unit="LENGTH",
                                            description="Space to keep between the top of stock and the ceiling")
    live: bpy.props.BoolProperty(name="Check as I move things", default=True)


class WH_OT_check(bpy.types.Operator):
    bl_idname = "wh.check"
    bl_label = "Check layout"
    bl_description = "Recount stock and look for clashes, roof and aisle problems"

    def execute(self, context):
        check_layout(context.scene)
        for area in context.screen.areas:
            area.tag_redraw()
        return {"FINISHED"}


class WH_OT_select_problems(bpy.types.Operator):
    bl_idname = "wh.select_problems"
    bl_label = "Select problems"
    bl_description = "Select every object with an issue"

    def execute(self, context):
        check_layout(context.scene)
        bpy.ops.object.select_all(action="DESELECT")
        for name in RESULTS.get("issues", {}):
            obj = context.scene.objects.get(name)
            if obj:
                obj.select_set(True)
                context.view_layer.objects.active = obj
        return {"FINISHED"}


class WH_OT_add(bpy.types.Operator):
    bl_idname = "wh.add"
    bl_label = "Add"
    bl_description = "Copy a library item to the 3D cursor"
    item: bpy.props.StringProperty()

    def execute(self, context):
        src = bpy.data.objects.get(self.item)
        if not src:
            self.report({"ERROR"}, f"Library item {self.item} is missing")
            return {"CANCELLED"}
        new = src.copy()
        new.data = src.data
        for key in ("wh_library",):
            if key in new:
                del new[key]
        new.name = src.name.replace("Library: ", "")
        cursor = context.scene.cursor.location
        new.location = (round(cursor.x, 1), round(cursor.y, 1), 0.0)
        target = bpy.data.collections.get("Stock and racking") or context.scene.collection
        target.objects.link(new)
        bpy.ops.object.select_all(action="DESELECT")
        new.select_set(True)
        context.view_layer.objects.active = new
        return {"FINISHED"}


class WH_OT_toggle(bpy.types.Operator):
    bl_idname = "wh.toggle"
    bl_label = "Show or hide"
    collection: bpy.props.StringProperty()

    def execute(self, context):
        layer = context.view_layer.layer_collection.children.get(self.collection)
        if layer:
            layer.hide_viewport = not layer.hide_viewport
        return {"FINISHED"}


class WH_OT_view(bpy.types.Operator):
    bl_idname = "wh.view"
    bl_label = "Viewport colours"
    bl_description = "Show the scanned product photos, or colour stacks by height"
    mode: bpy.props.StringProperty(default="TEXTURE")

    def execute(self, context):
        for area in context.screen.areas:
            if area.type == "VIEW_3D":
                shading = area.spaces.active.shading
                shading.type = "SOLID"
                shading.color_type = self.mode
        if self.mode == "OBJECT":
            bpy.ops.wh.recolour()
        return {"FINISHED"}


class WH_OT_recolour(bpy.types.Operator):
    bl_idname = "wh.recolour"
    bl_label = "Colour stacks by height"
    bl_description = "Recolour stacks after you change their height"

    def execute(self, context):
        for obj in stock_objects(context.scene):
            if obj.get("wh_kind", "stack") == "stack":
                obj.color = height_colour(obj.dimensions.z)
        return {"FINISHED"}


def height_colour(h):
    stops = [(0.0, (1.0, 0.88, 0.54)), (0.75, (0.99, 0.68, 0.38)), (1.5, (0.96, 0.43, 0.26)),
             (2.25, (0.84, 0.19, 0.15)), (3.0, (0.55, 0.04, 0.15))]
    for (h0, c0), (h1, c1) in zip(stops, stops[1:]):
        if h <= h1:
            t = max(0.0, (h - h0) / (h1 - h0))
            return tuple(a + t * (b - a) for a, b in zip(c0, c1)) + (1.0,)
    return stops[-1][1] + (1.0,)


def issue_kind(text):
    for key, kind in (("overlaps", "overlapping"), ("wall", "against a wall"), ("usable floor", "off the floor"),
                      ("ceiling", "too close to the roof"), ("aisle", "with no aisle beside them")):
        if key in text:
            return kind
    return "other"


class WH_PT_panel(bpy.types.Panel):
    bl_label = "Warehouse planner"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Warehouse"

    def draw(self, context):
        layout = self.layout
        props = context.scene.wh_settings
        col = layout.column(align=True)
        col.prop(props, "aisle_width")
        col.prop(props, "roof_clearance")
        layout.prop(props, "live")
        row = layout.row(align=True)
        row.operator("wh.check", icon="CHECKMARK")
        row.operator("wh.select_problems", icon="ERROR")

        if RESULTS.get("checked"):
            box = layout.box()
            box.label(text=f"Stacks {RESULTS['stacks']}   Racks/shelves {RESULTS['racks']}")
            box.label(text=f"Stock footprint {RESULTS['footprint']:.0f} m² of {RESULTS['usable']:.0f} m² usable")
            box.label(text=f"Stack volume {RESULTS['volume']:.0f} m³   Rack pallet places {RESULTS['positions']}")
            box.label(text=f"Free floor {RESULTS['free']:.0f} m², of which aisle-width {RESULTS['aisle']:.0f} m²")
            zbox = layout.box()
            zbox.label(text="Zone   floor   stock   free   m³")
            for z in RESULTS["zones"]:
                zbox.label(text=f"{z['id']}   {z['floor']:.0f}   {z['stock']:.0f}   {z['free']:.0f}   {z['volume']:.0f}")
            issues = RESULTS["issues"]
            ibox = layout.box()
            if not issues:
                ibox.label(text="No problems found", icon="CHECKMARK")
            else:
                ibox.label(text=f"{len(issues)} objects with problems", icon="ERROR")
                kinds = {}
                for texts in issues.values():
                    for kind in {issue_kind(t) for t in texts}:
                        kinds[kind] = kinds.get(kind, 0) + 1
                for kind, count in sorted(kinds.items(), key=lambda kv: -kv[1]):
                    ibox.label(text=f"   {count} {kind}")
                for name, texts in list(issues.items())[:12]:
                    ibox.label(text=f"{name}: {texts[0]}")
                if len(issues) > 12:
                    ibox.label(text=f"… and {len(issues) - 12} more (Select problems)")

        layout.separator()
        layout.label(text="Add at 3D cursor")
        grid = layout.grid_flow(columns=2, align=True)
        for obj in sorted((o for o in context.scene.objects if o.get("wh_library")), key=lambda o: o.name):
            op = grid.operator("wh.add", text=obj.name.replace("Library: ", ""))
            op.item = obj.name
        layout.label(text="View")
        row = layout.row(align=True)
        row.operator("wh.view", text="Product photos").mode = "TEXTURE"
        row.operator("wh.view", text="Height colours").mode = "OBJECT"
        col = layout.column(align=True)
        for name, label in (("Scan: roof", "Roof"), ("As scanned (outlines)", "Original positions"),
                            ("Floor plan", "Zones and plan walls"), ("Scan: building", "Building scan")):
            if name in bpy.data.collections:
                hidden = context.view_layer.layer_collection.children[name].hide_viewport
                col.operator("wh.toggle", text=("Show " if hidden else "Hide ") + label.lower(),
                             icon="HIDE_ON" if hidden else "HIDE_OFF").collection = name


# Live checking: re-run shortly after objects move.
_dirty = {"flag": False}


def _on_change(scene, depsgraph):
    if scene.get("wh_site") and scene.wh_settings.live:
        for update in depsgraph.updates:
            if update.is_updated_transform and getattr(update.id, "get", None) and update.id.get("wh_stack"):
                _dirty["flag"] = True
                break


def _timer():
    if _dirty["flag"]:
        _dirty["flag"] = False
        scene = bpy.context.scene
        if scene and scene.get("wh_site"):
            try:
                check_layout(scene)
                for window in bpy.context.window_manager.windows:
                    for area in window.screen.areas:
                        if area.type == "VIEW_3D":
                            area.tag_redraw()
            except Exception as exc:  # keep the timer alive
                print("Warehouse check failed:", exc)
    return 0.4


CLASSES = (WH_Settings, WH_OT_check, WH_OT_select_problems, WH_OT_add, WH_OT_toggle, WH_OT_view, WH_OT_recolour,
           WH_PT_panel)


def register():
    for cls in CLASSES:
        try:
            bpy.utils.register_class(cls)
        except ValueError:
            bpy.utils.unregister_class(cls)
            bpy.utils.register_class(cls)
    bpy.types.Scene.wh_settings = bpy.props.PointerProperty(type=WH_Settings)
    if _on_change not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(_on_change)
    if not bpy.app.timers.is_registered(_timer):
        bpy.app.timers.register(_timer, first_interval=1.0, persistent=True)


if __name__ == "__main__":
    register()
