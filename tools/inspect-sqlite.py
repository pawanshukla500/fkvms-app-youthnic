"""Read-only dump of a Forward Scan SQLite snapshot: tables, columns, row counts."""
import sqlite3
import sys

path = sys.argv[1]
con = sqlite3.connect(path)
cur = con.cursor()

cur.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
objects = cur.fetchall()
print(f"=== {len(objects)} tables/views in {path} ===")

for name, kind in objects:
    try:
        cur.execute(f'SELECT COUNT(*) FROM "{name}"')
        count = cur.fetchone()[0]
    except Exception as exc:
        count = f"err: {exc}"
    print(f"\n--- {kind} {name}  (rows={count}) ---")
    cur.execute(f'PRAGMA table_info("{name}")')
    for _, col, ctype, notnull, _, pk in cur.fetchall():
        flags = []
        if pk:
            flags.append("PK")
        if notnull:
            flags.append("NOT NULL")
        print(f"    {col:34} {ctype or '?':14} {' '.join(flags)}")

print("\n=== foreign keys ===")
for name, _ in objects:
    cur.execute(f'PRAGMA foreign_key_list("{name}")')
    for row in cur.fetchall():
        print(f"    {name}.{row[3]} -> {row[2]}.{row[4]}")

print("\n=== indexes ===")
cur.execute("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name")
for name, tbl, sql in cur.fetchall():
    print(f"    {tbl}: {sql}")

con.close()
