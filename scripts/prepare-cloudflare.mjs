import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = resolve(root, 'wrangler.cloudflare.jsonc');
const generatedPath = resolve(root, 'dist/server/wrangler.json');
const outputPath = resolve(root, 'dist/cloudflare/wrangler.json');
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const args = process.argv.slice(2);
let databaseId = process.env.WM_CLOUDFLARE_DATABASE_ID?.trim() ?? source.d1_databases?.find(value => value.binding === 'DB')?.database_id ?? '';
let databaseName;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--database-id' && args[i + 1] && !args[i + 1].startsWith('--')) databaseId = args[++i].trim();
  else if (args[i] === '--database-name' && args[i + 1] && !args[i + 1].startsWith('--')) databaseName = args[++i].trim();
  else throw new Error('Usage: node scripts/prepare-cloudflare.mjs [--database-id UUID] [--database-name NAME]');
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!uuid.test(databaseId) || /^00000000-/i.test(databaseId)) {
  throw new Error('A real Cloudflare D1 database UUID is required. Set WM_CLOUDFLARE_DATABASE_ID or pass --database-id. The Sites placeholder is never deployable.');
}
if (databaseName !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(databaseName)) {
  throw new Error('The D1 database name must contain only letters, numbers, underscores, or hyphens.');
}

const generated = JSON.parse(await readFile(generatedPath, 'utf8').catch(error => {
  if (error.code === 'ENOENT') throw new Error('Build the application first: pnpm build.');
  throw error;
}));
if (!/^[0-9a-f]{32}$/i.test(source.account_id ?? '')) throw new Error('The standalone Cloudflare account_id is missing or invalid.');
if (generated.no_bundle !== true) throw new Error('Expected the prebuilt Vinext Worker output with no_bundle: true.');
if (!Array.isArray(generated.d1_databases) || generated.d1_databases.length !== 1 || generated.d1_databases[0].binding !== 'DB') {
  throw new Error('Expected exactly one generated D1 binding named DB. Review changed build bindings before deploying.');
}
if (!Array.isArray(source.d1_databases) || source.d1_databases.length !== 1 || source.d1_databases[0].binding !== 'DB') {
  throw new Error('Expected exactly one standalone D1 binding named DB.');
}
for (const [label, config] of [['generated', generated], ['standalone', source]]) {
  for (const binding of ['services', 'kv_namespaces', 'r2_buckets']) {
    const entries = config[binding];
    if (entries?.length) throw new Error(`Unexpected ${binding} bindings in the ${label} configuration. Review them before standalone deployment.`);
  }
}

function isPasswordHasherBinding(value) {
  return value && Object.keys(value).length === 2 && value.name === 'PASSWORD_HASHER' && value.class_name === 'PasswordHasher';
}
const durableBindings = source.durable_objects?.bindings;
if (!Array.isArray(durableBindings) || durableBindings.length !== 1 || !isPasswordHasherBinding(durableBindings[0])) {
  throw new Error('The standalone configuration must bind only PASSWORD_HASHER to its own PasswordHasher class.');
}
const generatedDurableBindings = generated.durable_objects?.bindings ?? [];
if (!Array.isArray(generatedDurableBindings) || generatedDurableBindings.length > 1 || generatedDurableBindings.length === 1 && !isPasswordHasherBinding(generatedDurableBindings[0])) {
  throw new Error('Unexpected Durable Object bindings in the generated build.');
}
if (source.vars?.REQUIRE_PASSWORD_HASHER !== 'true') {
  throw new Error('Standalone authentication must require its private PASSWORD_HASHER binding.');
}

function isPasswordHasherMigration(value) {
  return value && Object.keys(value).length === 2 && value.tag === 'v1-password-hasher'
    && Array.isArray(value.new_sqlite_classes) && value.new_sqlite_classes.length === 1 && value.new_sqlite_classes[0] === 'PasswordHasher';
}
if (!Array.isArray(source.migrations) || source.migrations.length !== 1 || !isPasswordHasherMigration(source.migrations[0])) {
  throw new Error('The standalone configuration must declare v1-password-hasher with new_sqlite_classes: [PasswordHasher].');
}
const generatedMigrations = generated.migrations ?? [];
if (!Array.isArray(generatedMigrations) || generatedMigrations.length > 1 || generatedMigrations.length === 1 && !isPasswordHasherMigration(generatedMigrations[0])) {
  throw new Error('Generated Durable Object migrations conflict with the standalone PasswordHasher migration.');
}
// The Vite build can contain the same migration or no DO migration. Keep the
// standalone SQLite class declaration exactly once in either case.
const migrations = [...new Map([...generatedMigrations, ...source.migrations].map(value => [value.tag, value])).values()];

function outputRelative(absolutePath) {
  const value = relative(dirname(outputPath), absolutePath).split('\\').join('/');
  return value.startsWith('.') ? value : `./${value}`;
}

async function builtPath(value, expectedPath, kind) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) throw new Error(`Expected a relative generated ${kind} path.`);
  const absolutePath = resolve(dirname(generatedPath), value);
  if (absolutePath !== resolve(root, expectedPath)) throw new Error(`Unexpected generated ${kind} path: ${value}`);
  const metadata = await stat(absolutePath);
  if (kind === 'main' ? !metadata.isFile() : !metadata.isDirectory()) throw new Error(`The built ${kind} is missing.`);
  return outputRelative(absolutePath);
}

const main = await builtPath(generated.main, 'dist/server/index.js', 'main');
const assetsDirectory = await builtPath(generated.assets?.directory, 'dist/client', 'assets');
if (source.assets?.binding !== 'ASSETS' || generated.assets?.binding && generated.assets.binding !== 'ASSETS') {
  throw new Error('The standalone Worker must bind its built static assets as ASSETS.');
}
const database = source.d1_databases?.find(value => value.binding === 'DB');
if (!database) throw new Error('The standalone source configuration must declare the DB binding.');

// Deliberately copy only build requirements. Sites metadata, preview services,
// generated vars, routes, and deployment identities are never inherited. Only
// the required, non-secret password-hasher policy flag comes from source vars.
const config = {
  $schema: outputRelative(resolve(root, 'node_modules/wrangler/config-schema.json')),
  name: source.name,
  account_id: source.account_id,
  main,
  compatibility_date: generated.compatibility_date ?? source.compatibility_date,
  compatibility_flags: generated.compatibility_flags ?? source.compatibility_flags,
  no_bundle: true,
  workers_dev: source.workers_dev,
  preview_urls: source.preview_urls,
  vars: { REQUIRE_PASSWORD_HASHER: 'true' },
  durable_objects: { bindings: durableBindings },
  migrations,
  assets: { ...generated.assets, directory: assetsDirectory, binding: 'ASSETS' },
  ...(generated.rules?.length ? { rules: generated.rules } : {}),
  d1_databases: [{
    binding: 'DB',
    database_name: databaseName ?? database.database_name,
    database_id: databaseId,
    migrations_dir: outputRelative(resolve(root, 'drizzle')),
  }],
  observability: source.observability,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`Prepared ${relative(root, outputPath)} for Worker ${config.name}. No resources were created or deployed.`);
