/**
 * Read-only verification report for a Forward Scan database.
 *
 * Run before putting a desk into service: it confirms the connection is
 * read-only, the schema matches what the lookup expects, lists the seller
 * accounts, measures real lookup latency, and reports how many SKUs actually
 * have a product image. That last figure is the one that decides whether
 * operators will see pictures or only SKU codes.
 *
 *   npm run verify
 */

import { readOnlyQuery, auditReadOnlyPrivileges, describeSource, closePool } from './db.js';
import { verifySchema } from './schema.js';
import { lookupByTrackingId, listSellerAccounts } from './lookup.js';
import { normalizeSkuKey } from './normalize.js';

const LATENCY_SAMPLE = 25;

function heading(text) {
  console.log(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`);
}

async function main() {
  const source = describeSource();

  heading('Source');
  console.log(`  driver : ${source.driver}`);
  console.log(`  target : ${source.target || '(VMS_DATABASE_URL is not set)'}`);

  if (source.driver === 'unset') {
    console.error('\nSet VMS_DATABASE_URL in backend/.env first.');
    process.exitCode = 1;
    return;
  }

  heading('Read-only audit');
  try {
    const audit = await auditReadOnlyPrivileges();
    console.log(`  status     : ${audit.status}`);
    for (const [key, value] of Object.entries(audit)) {
      if (key === 'status') continue;
      console.log(`  ${key.padEnd(10)} : ${Array.isArray(value) ? JSON.stringify(value) : value}`);
    }
    if (audit.status !== 'read_only') {
      console.error('\n  REFUSE TO PACK: this connection can modify Forward Scan.');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`  failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  heading('Schema');
  const schema = await verifySchema({ force: true });
  if (schema.ok) {
    console.log('  oms_orders, sku_photos and channels all present with the expected columns.');
  } else {
    console.error(`  ${schema.reason}`);
    process.exitCode = 1;
    return;
  }

  heading('Tracking index');
  // Without an index on tracking_norm, every scan is a full table scan and the
  // sub-second target will not hold as the table grows.
  try {
    const indexes = source.driver === 'sqlite'
      ? await readOnlyQuery(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'oms_orders'",
      )
      : await readOnlyQuery(
        "SELECT indexname AS name, indexdef AS sql FROM pg_indexes WHERE tablename = 'oms_orders'",
      );
    const onTracking = indexes.filter((row) => /tracking/i.test(String(row.sql || row.name)));
    if (onTracking.length === 0) {
      console.error('  NO index covers oms_orders.tracking_norm - lookups will degrade as orders accumulate.');
    } else {
      for (const row of onTracking) console.log(`  ${row.name}`);
    }
  } catch (err) {
    console.log(`  could not read indexes: ${err.message}`);
  }

  heading('Seller accounts (channels)');
  const accounts = await listSellerAccounts(false);
  for (const account of accounts) {
    const flag = account.scanEnabled ? 'scan' : '    ';
    console.log(
      `  [${flag}] channelId=${String(account.channelId).padEnd(6)} `
      + `${String(account.company).padEnd(18)} ${String(account.marketplace).padEnd(26)} ${account.name}`,
    );
  }
  console.log('\n  Use the channelId values above in the desk setup wizard, step 4.');

  heading('Orders per account');
  const perChannel = await readOnlyQuery(`
    SELECT o.channel_id,
           o.channel_label,
           COUNT(*) AS orders
    FROM oms_orders o
    GROUP BY o.channel_id, o.channel_label
    ORDER BY COUNT(*) DESC
  `);
  for (const row of perChannel) {
    console.log(`  ${String(row.orders).padStart(7)}  channelId=${String(row.channel_id).padEnd(6)} ${row.channel_label}`);
  }

  heading('Product image coverage');
  const photos = await readOnlyQuery('SELECT sku FROM sku_photos');
  const photoKeys = new Set(photos.map((row) => row.sku));
  console.log(`  sku_photos rows: ${photoKeys.size}`);

  const sampled = await readOnlyQuery(`
    SELECT channel_id, channel_label, items_json
    FROM oms_orders
    WHERE items_json <> '' AND items_json <> '[]'
  `);

  const coverage = new Map();
  for (const row of sampled) {
    let items;
    try {
      items = JSON.parse(row.items_json);
    } catch {
      continue;
    }
    if (!Array.isArray(items)) continue;

    const key = `${row.channel_id}|${row.channel_label}`;
    if (!coverage.has(key)) coverage.set(key, { lines: 0, withImage: 0 });
    const bucket = coverage.get(key);

    for (const item of items) {
      if (!item || !item.sku) continue;
      bucket.lines += 1;
      if (item.image_url || photoKeys.has(normalizeSkuKey(item.sku))) bucket.withImage += 1;
    }
  }

  for (const [key, bucket] of [...coverage.entries()].sort((a, b) => b[1].lines - a[1].lines)) {
    const [channelId, label] = key.split('|');
    const pct = bucket.lines ? (100 * bucket.withImage / bucket.lines) : 0;
    const warn = pct < 50 ? '  <-- operators will mostly see no picture' : '';
    console.log(
      `  ${pct.toFixed(1).padStart(5)}%  ${String(bucket.withImage).padStart(5)}/${String(bucket.lines).padEnd(6)} `
      + `channelId=${String(channelId).padEnd(6)} ${label}${warn}`,
    );
  }

  heading(`Lookup latency (${LATENCY_SAMPLE} real tracking IDs)`);
  const samples = await readOnlyQuery(`
    SELECT tracking_raw, channel_id
    FROM oms_orders
    WHERE tracking_norm <> ''
    ORDER BY synced_at DESC
    LIMIT ${LATENCY_SAMPLE}
  `);

  if (samples.length === 0) {
    console.log('  No orders with a tracking ID to sample.');
  } else {
    const timings = [];
    let found = 0;
    for (const sample of samples) {
      const started = process.hrtime.bigint();
      const result = await lookupByTrackingId('flipkart', sample.tracking_raw, sample.channel_id);
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      if (result.status === 'found') found += 1;
    }
    timings.sort((a, b) => a - b);
    const avg = timings.reduce((sum, value) => sum + value, 0) / timings.length;
    console.log(`  resolved      : ${found}/${samples.length}`);
    console.log(`  average       : ${avg.toFixed(1)} ms`);
    console.log(`  median        : ${timings[Math.floor(timings.length / 2)].toFixed(1)} ms`);
    console.log(`  slowest       : ${timings[timings.length - 1].toFixed(1)} ms`);
    console.log(`  target        : under 1000 ms`);
  }

  heading('Sample resolved scan');
  if (samples.length > 0) {
    const result = await lookupByTrackingId('flipkart', samples[0].tracking_raw, samples[0].channel_id);
    console.log(JSON.stringify(result, null, 2));
  }
}

main()
  .catch((err) => {
    console.error(`\nVerification failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
