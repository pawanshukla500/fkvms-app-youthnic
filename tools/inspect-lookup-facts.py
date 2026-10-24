"""Read-only extraction of the facts the tracking -> SKU + qty + image lookup depends on."""
import json
import sqlite3
import sys

con = sqlite3.connect(sys.argv[1])
con.row_factory = sqlite3.Row
cur = con.cursor()

print("=== channels (seller accounts) ===")
for r in cur.execute(
    "SELECT id, name, marketplace, company, oms_status, scan_enabled, aliases FROM channels ORDER BY id"
):
    print(
        f"  id={r['id']:<3} marketplace={r['marketplace']:<12} company={r['company']:<18} "
        f"scan={r['scan_enabled']} name={r['name']}"
    )
    if r["aliases"] and r["aliases"] not in ("[]", ""):
        print(f"        aliases={r['aliases']}")

print("\n=== distinct oms_orders.company / channel_label ===")
for r in cur.execute(
    "SELECT company, channel_label, channel_id, COUNT(*) n FROM oms_orders "
    "GROUP BY company, channel_label, channel_id ORDER BY n DESC"
):
    print(f"  n={r['n']:<6} company={r['company']:<18} channel_id={r['channel_id']} label={r['channel_label']}")

print("\n=== items_json shape (3 samples) ===")
for r in cur.execute(
    "SELECT tracking_norm, item_count, total_qty, items_json FROM oms_orders "
    "WHERE items_json != '' AND items_json != '[]' LIMIT 3"
):
    print(f"\n  tracking_norm={r['tracking_norm']} item_count={r['item_count']} total_qty={r['total_qty']}")
    try:
        parsed = json.loads(r["items_json"])
        print(f"  parsed type={type(parsed).__name__}")
        print(json.dumps(parsed, indent=4)[:1600])
    except Exception as exc:
        print(f"  unparseable: {exc}; raw={r['items_json'][:400]}")

print("\n=== union of item keys across 500 orders ===")
keys = {}
for r in cur.execute("SELECT items_json FROM oms_orders WHERE items_json NOT IN ('', '[]') LIMIT 500"):
    try:
        for item in json.loads(r["items_json"]):
            if isinstance(item, dict):
                for k, v in item.items():
                    keys.setdefault(k, set()).add(type(v).__name__)
    except Exception:
        pass
for k in sorted(keys):
    print(f"  {k:28} types={sorted(keys[k])}")

print("\n=== sku_photos samples ===")
for r in cur.execute("SELECT sku, title, marketplace, image_url FROM sku_photos LIMIT 5"):
    print(f"  sku={r['sku']} marketplace={r['marketplace']}")
    print(f"      title={r['title']}")
    print(f"      image_url={r['image_url'][:160]}")

print("\n=== sku_photos marketplace distribution ===")
for r in cur.execute("SELECT marketplace, COUNT(*) n FROM sku_photos GROUP BY marketplace ORDER BY n DESC"):
    print(f"  {r['marketplace']:<16} {r['n']}")

print("\n=== image_url coverage ===")
r = cur.execute(
    "SELECT COUNT(*) total, SUM(CASE WHEN image_url IS NULL OR image_url='' THEN 1 ELSE 0 END) empty FROM sku_photos"
).fetchone()
print(f"  total={r['total']} empty_image_url={r['empty']}")

print("\n=== tracking_raw vs tracking_norm (5 samples) ===")
for r in cur.execute(
    "SELECT tracking_raw, tracking_norm FROM oms_orders WHERE tracking_norm != '' LIMIT 5"
):
    print(f"  raw={r['tracking_raw']!r:30} norm={r['tracking_norm']!r}")

print("\n=== duplicate tracking_norm across channels ===")
rows = list(
    cur.execute(
        "SELECT tracking_norm, COUNT(*) n, COUNT(DISTINCT channel_id) ch FROM oms_orders "
        "WHERE tracking_norm != '' GROUP BY tracking_norm HAVING n > 1 ORDER BY n DESC LIMIT 10"
    )
)
print(f"  duplicated tracking_norm values: {len(rows)} (showing up to 10)")
for r in rows:
    print(f"    {r['tracking_norm']} rows={r['n']} distinct_channels={r['ch']}")

print("\n=== status_group / source distribution ===")
for r in cur.execute("SELECT status_group, COUNT(*) n FROM oms_orders GROUP BY status_group ORDER BY n DESC"):
    print(f"  status_group={r['status_group']:<12} {r['n']}")

print("\n=== sync_state ===")
for r in cur.execute("SELECT key, value, updated_at FROM sync_state ORDER BY key"):
    print(f"  {r['key']:<28} {str(r['value'])[:70]}  ({r['updated_at']})")

con.close()
