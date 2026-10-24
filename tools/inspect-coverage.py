"""Read-only check: for each seller channel, how many order SKUs have a photo."""
import json
import sqlite3
import sys
from collections import defaultdict

con = sqlite3.connect(sys.argv[1])
con.row_factory = sqlite3.Row
cur = con.cursor()

photos = {}
for r in cur.execute("SELECT sku, marketplace, image_url, title FROM sku_photos"):
    photos.setdefault(r["sku"], []).append(dict(r))

photo_upper = {k.upper(): v for k, v in photos.items()}

per_channel = defaultdict(lambda: {"orders": 0, "items": 0, "matched": 0, "matched_ci": 0, "missing": set()})

for r in cur.execute(
    "SELECT channel_id, channel_label, items_json FROM oms_orders WHERE items_json NOT IN ('', '[]')"
):
    key = (r["channel_id"], r["channel_label"])
    bucket = per_channel[key]
    bucket["orders"] += 1
    try:
        items = json.loads(r["items_json"])
    except Exception:
        continue
    for item in items:
        sku = (item or {}).get("sku")
        if not sku:
            continue
        bucket["items"] += 1
        if sku in photos:
            bucket["matched"] += 1
        elif sku.upper() in photo_upper:
            bucket["matched_ci"] += 1
        else:
            bucket["missing"].add(sku)

print("=== SKU photo coverage per channel ===")
for (cid, label), b in sorted(per_channel.items(), key=lambda kv: -kv[1]["items"]):
    total = b["items"] or 1
    pct = 100.0 * (b["matched"] + b["matched_ci"]) / total
    print(
        f"\n  channel_id={cid}  {label}"
        f"\n    orders={b['orders']} item_lines={b['items']}"
        f"\n    exact photo match={b['matched']}  case-insensitive-only={b['matched_ci']}"
        f"\n    no photo={len(b['missing'])} distinct SKUs   coverage={pct:.1f}%"
    )
    for sku in list(sorted(b["missing"]))[:5]:
        print(f"      missing e.g. {sku}")

print("\n=== does sku_photos.marketplace matter for matching? ===")
cur.execute("SELECT DISTINCT marketplace FROM sku_photos ORDER BY marketplace")
print("  sku_photos marketplaces:", [r[0] for r in cur.fetchall()])
dupes = [k for k, v in photos.items() if len(v) > 1]
print(f"  SKUs present under more than one marketplace: {len(dupes)}")
for k in dupes[:5]:
    print(f"    {k}: {[p['marketplace'] for p in photos[k]]}")

print("\n=== image_url hosts ===")
hosts = defaultdict(int)
for v in photos.values():
    for p in v:
        url = p["image_url"] or ""
        host = url.split("/")[2] if url.startswith("http") and len(url.split("/")) > 2 else "(none)"
        hosts[host] += 1
for h, n in sorted(hosts.items(), key=lambda kv: -kv[1]):
    print(f"  {h:<42} {n}")

con.close()
