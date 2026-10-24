"""Read-only: compare the SKU format in sku_photos against the SKU format in order items."""
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict

con = sqlite3.connect(sys.argv[1])
con.row_factory = sqlite3.Row
cur = con.cursor()

print("=== sku_photos samples per marketplace ===")
for mp in [r[0] for r in cur.execute("SELECT DISTINCT marketplace FROM sku_photos ORDER BY marketplace")]:
    print(f"\n  -- {mp} --")
    for r in cur.execute("SELECT sku, title FROM sku_photos WHERE marketplace=? LIMIT 8", (mp,)):
        print(f"     {r['sku']:<34} {r['title'][:70]}")

print("\n=== order item SKU samples per channel ===")
for r in cur.execute(
    "SELECT channel_label, items_json FROM oms_orders WHERE items_json NOT IN ('','[]') "
    "GROUP BY channel_label"
):
    try:
        skus = [i.get("sku") for i in json.loads(r["items_json"])]
    except Exception:
        skus = []
    print(f"  {r['channel_label']:<40} {skus}")

# Build photo index under several normalisations to see if any rescues the match.
def norm_basic(s):
    return s.strip().upper()

def norm_nosep(s):
    return re.sub(r"[^A-Z0-9]", "", s.upper())

def norm_nosize(s):
    return re.sub(r"_(XS|S|M|L|XL|2XL|3XL|4XL|5XL|XXL|FREE ?SIZE)$", "", s.strip().upper())

def norm_nosize_nosep(s):
    return re.sub(r"[^A-Z0-9]", "", norm_nosize(s))

strategies = {
    "exact": lambda s: s,
    "upper": norm_basic,
    "strip-separators": norm_nosep,
    "strip-size-suffix": norm_nosize,
    "strip-size+separators": norm_nosize_nosep,
}

photo_rows = list(cur.execute("SELECT sku, marketplace FROM sku_photos"))
indexes = {name: defaultdict(set) for name in strategies}
for r in photo_rows:
    for name, fn in strategies.items():
        indexes[name][fn(r["sku"])].add(r["marketplace"])

target_channels = {
    17040: "ETHNIC JUNCTION - Flipkart",
    51680: "ETHNIC JUNCTION - Myntra Youthnic",
    18116: "VB EXPORT - Myntra PPMP",
}

order_skus = defaultdict(Counter)
for r in cur.execute(
    "SELECT channel_id, items_json FROM oms_orders WHERE items_json NOT IN ('','[]')"
):
    if r["channel_id"] not in target_channels:
        continue
    try:
        for item in json.loads(r["items_json"]):
            sku = (item or {}).get("sku")
            if sku:
                order_skus[r["channel_id"]][sku] += 1
    except Exception:
        pass

print("\n=== match rate by normalisation strategy (distinct SKUs) ===")
for cid, label in target_channels.items():
    skus = list(order_skus[cid])
    print(f"\n  {label}  ({len(skus)} distinct SKUs)")
    for name, fn in strategies.items():
        hit = sum(1 for s in skus if fn(s) in indexes[name])
        pct = 100.0 * hit / len(skus) if skus else 0
        print(f"    {name:<24} {hit:>4}/{len(skus)}  {pct:5.1f}%")

print("\n=== title availability (SKU name) is separate from image ===")
r = cur.execute("SELECT COUNT(*) n FROM sku_photos WHERE title != ''").fetchone()
print(f"  sku_photos rows with a non-empty title: {r['n']}")
print("  NOTE: order items carry only sku/qty/sub_order_id/status/amount - no title, no image.")

con.close()
