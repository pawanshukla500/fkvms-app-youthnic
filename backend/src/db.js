/**
 * Read-only access to the Forward Scan database.
 *
 * Forward Scan can run on either SQLite or PostgreSQL (its own
 * `backend/app/config.py` defaults to `sqlite:///omsguru_forward_scan.db`), so
 * this module supports both and picks the driver from the URL.
 *
 * Layers that keep the access read-only:
 *   1. SQLite is opened with the SQLITE_OPEN_READONLY flag, which the engine
 *      itself enforces; PostgreSQL should use a role holding SELECT and nothing
 *      else (see DEPLOYMENT.md). That is the layer that actually enforces it.
 *   2. Every PostgreSQL statement runs inside BEGIN READ ONLY ... COMMIT.
 *   3. Only SELECT and WITH statements are accepted by this module.
 *   4. Values are always bound as parameters, never interpolated.
 */

import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

dotenv.config();

const { Pool } = pg;

const CONNECTION_STRING = (process.env.VMS_DATABASE_URL || '').trim();
const QUERY_TIMEOUT_MS = Number.parseInt(process.env.VMS_DB_QUERY_TIMEOUT_MS || '2000', 10);

// A lookup service needs very few connections, and a small pool keeps memory
// and the server's connection slots in check.
const POOL_MAX = Number.parseInt(process.env.VMS_DB_POOL_MAX || '5', 10);

const READ_ONLY_STATEMENT = /^\s*(?:SELECT|WITH)\b/i;

/** Statements that must never reach the database from this service. */
const FORBIDDEN = /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|REFRESH|ATTACH|PRAGMA)\b/i;

let pool = null;
let sqliteDb = null;

/**
 * Which driver the configured URL implies.
 *
 * @returns {'sqlite'|'postgres'|'unset'}
 */
export function getDriver() {
  if (!CONNECTION_STRING) return 'unset';
  if (/^sqlite:/i.test(CONNECTION_STRING)) return 'sqlite';
  if (/^\.{0,2}[/\\]/.test(CONNECTION_STRING) || /^[A-Za-z]:[/\\]/.test(CONNECTION_STRING)) return 'sqlite';
  if (/\.(?:db|sqlite3?)$/i.test(CONNECTION_STRING)) return 'sqlite';
  return 'postgres';
}

/**
 * Absolute path to the SQLite file named by the URL.
 *
 * Accepts the SQLAlchemy forms Forward Scan uses (`sqlite:///relative.db`,
 * `sqlite:////abs/path.db`) as well as a bare Windows or POSIX path, so the
 * value can be pasted straight from Forward Scan's own `.env`.
 */
export function getSqlitePath() {
  let raw = CONNECTION_STRING;
  if (/^sqlite:/i.test(raw)) {
    raw = raw.replace(/^sqlite:(\/\/)?/i, '');
    // sqlite:////abs/path -> /abs/path ; sqlite:///rel.db -> rel.db
    if (raw.startsWith('//')) raw = raw.slice(1);
    else if (raw.startsWith('/') && !/^\/[A-Za-z]:/.test(raw)) raw = raw.slice(1);
  }
  raw = raw.split('?')[0];
  return path.resolve(raw);
}

/**
 * TLS settings for the PostgreSQL pool.
 *
 * `sslmode` in the connection string is honoured by node-postgres only for a
 * subset of values, so it is translated explicitly here. Verification stays on
 * unless the deployment explicitly opts out, because turning it off silently
 * would defeat the point of using TLS at all.
 */
function resolveSsl(connectionString) {
  const mode = (() => {
    try {
      return new URL(connectionString).searchParams.get('sslmode');
    } catch {
      return null;
    }
  })();

  const configured = (process.env.VMS_DATABASE_SSL || '').toLowerCase();

  // An explicit deployment setting wins over a URL hint. In particular,
  // sslmode=require means encryption without certificate verification in
  // libpq terminology, but this service's documented default is verify.
  if (configured === 'disable') return false;
  if (configured === 'no-verify') {
    return { rejectUnauthorized: false };
  }
  if (configured === 'verify') {
    return { rejectUnauthorized: true };
  }
  if (mode === 'disable') return false;
  if (mode === 'require' || mode === 'prefer') {
    return { rejectUnauthorized: false };
  }
  if (mode === 'verify-full' || mode === 'verify-ca') {
    return { rejectUnauthorized: true };
  }
  // No TLS preference expressed: leave it to the driver's default so a plain
  // internal network connection keeps working.
  return undefined;
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: CONNECTION_STRING,
      max: POOL_MAX,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      // Applied per connection so a runaway query cannot pin a pool slot.
      statement_timeout: QUERY_TIMEOUT_MS,
      application_name: 'youthnic-packing-lookup',
      ssl: resolveSsl(CONNECTION_STRING),
    });

    pool.on('error', (err) => {
      // An idle client dropping is routine; the pool replaces it on next use.
      console.error('[db] idle client error:', err.message);
    });
  }

  return pool;
}

function getSqlite() {
  if (!sqliteDb) {
    const file = getSqlitePath();
    if (!fs.existsSync(file)) {
      throw new Error(`Forward Scan SQLite file not found: ${file}`);
    }
    // readOnly is enforced by SQLite itself, not by this process.
    sqliteDb = new DatabaseSync(file, { readOnly: true });
  }
  return sqliteDb;
}

/**
 * Rewrite `$1`-style placeholders to the `?` form SQLite expects, reordering
 * the bound values to match the order the placeholders appear in.
 *
 * Keeps a single query string usable by both drivers, and keeps repeated
 * references to the same placeholder correct.
 */
function toSqliteParams(text, params) {
  const ordered = [];
  const rewritten = text.replace(/\$(\d+)/g, (_, index) => {
    ordered.push(toSqliteValue(params[Number(index) - 1]));
    return '?';
  });
  return { text: rewritten, params: ordered };
}

/**
 * node:sqlite accepts only null, number, bigint, string and buffer. Booleans
 * and dates are common in query parameters, so they are translated rather than
 * left to throw at bind time.
 */
function toSqliteValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
}

/**
 * Run a SELECT against Forward Scan without the possibility of writing.
 *
 * @param {string} text parameterized SQL using `$1`-style placeholders
 * @param {Array} params bound values
 * @returns {Promise<Array<object>>} rows
 */
export async function readOnlyQuery(text, params = []) {
  if (getDriver() === 'unset') {
    throw new Error('VMS_DATABASE_URL is not set, so the Forward Scan database cannot be reached.');
  }
  if (!READ_ONLY_STATEMENT.test(text)) {
    throw new Error('Only SELECT and WITH statements are permitted.');
  }
  if (FORBIDDEN.test(text)) {
    throw new Error('Statement contains a write or DDL keyword and was refused.');
  }

  if (getDriver() === 'sqlite') {
    const converted = toSqliteParams(text, params);
    const statement = getSqlite().prepare(converted.text);
    // SQLite returns integers as BigInt when they exceed 2^53; the lookup only
    // reads ids and quantities, so coercing here keeps JSON output plain.
    return statement.all(...converted.params).map(coerceBigInts);
  }

  const client = await getPool().connect();

  try {
    // READ ONLY has to be part of the transaction start; issued on its own it
    // would be rejected outside a transaction block.
    await client.query('BEGIN READ ONLY');
    try {
      const result = await client.query({ text, values: params });
      await client.query('COMMIT');
      return result.rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}

function coerceBigInts(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}

export async function testConnection() {
  const rows = await readOnlyQuery('SELECT 1 AS ok');
  return rows.length === 1 && Number(rows[0].ok) === 1;
}

/** Human-readable description of the source, with no credentials in it. */
export function describeSource() {
  const driver = getDriver();
  if (driver === 'unset') return { driver, target: null };
  if (driver === 'sqlite') return { driver, target: getSqlitePath() };
  try {
    const url = new URL(CONNECTION_STRING);
    return { driver, target: `${url.hostname}:${url.port || 5432}${url.pathname}` };
  } catch {
    return { driver, target: 'unparseable URL' };
  }
}

/**
 * Report what the connection is actually allowed to do.
 *
 * For PostgreSQL this is deliberately implemented with catalog queries instead
 * of attempting a write: if the role turned out to be writable, a test INSERT
 * would have modified Forward Scan, which is exactly what must never happen.
 */
export async function auditReadOnlyPrivileges() {
  if (getDriver() === 'sqlite') {
    const file = getSqlitePath();
    // A read-only handle cannot write regardless of file permissions, so the
    // flag is the guarantee; the permission check is reported as context only.
    let fileWritable = false;
    try {
      fs.accessSync(file, fs.constants.W_OK);
      fileWritable = true;
    } catch {
      fileWritable = false;
    }

    return {
      status: 'read_only',
      driver: 'sqlite',
      database: file,
      enforcedBy: 'SQLITE_OPEN_READONLY',
      fileWritableByThisProcess: fileWritable,
      note: fileWritable
        ? 'The handle is opened read-only, so writes are refused by SQLite. The file itself is writable by this account; mark it read-only at the filesystem level for defence in depth.'
        : 'The handle is opened read-only and the file is not writable by this account.',
    };
  }

  const [identity] = await readOnlyQuery(`
    SELECT current_user AS role_name,
           current_database() AS database_name,
           rolsuper AS is_superuser,
           rolcreatedb AS can_create_db,
           rolcreaterole AS can_create_role
    FROM pg_roles
    WHERE rolname = current_user
  `);

  const writable = await readOnlyQuery(`
    SELECT table_schema, table_name, privilege_type
    FROM information_schema.table_privileges
    WHERE grantee = current_user
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
    ORDER BY table_schema, table_name, privilege_type
  `);

  const readable = await readOnlyQuery(`
    SELECT count(*)::int AS tables_readable
    FROM information_schema.table_privileges
    WHERE grantee = current_user
      AND privilege_type = 'SELECT'
  `);

  const schemaCreate = await readOnlyQuery(`
    SELECT nspname AS schema_name
    FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND has_schema_privilege(current_user, nspname, 'CREATE')
    ORDER BY nspname
  `);

  const readOnly = !identity.is_superuser
    && writable.length === 0
    && schemaCreate.length === 0;

  return {
    status: readOnly ? 'read_only' : 'not_read_only',
    driver: 'postgres',
    role: identity.role_name,
    database: identity.database_name,
    isSuperuser: identity.is_superuser,
    canCreateDb: identity.can_create_db,
    canCreateRole: identity.can_create_role,
    tablesReadable: readable[0].tables_readable,
    writePrivileges: writable,
    schemasWithCreate: schemaCreate.map((row) => row.schema_name),
    // A superuser bypasses every grant, so it can never be certified read-only.
    note: readOnly
      ? 'The role holds no write, DDL or schema-create privileges.'
      : 'This role can modify the database. Switch the backend to a SELECT-only role before packing.',
  };
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
}
