/** The JSON columns hold versioned logical records from the shared protocol. */
export function initializeSchema(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS schema_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL)");
    const version = sql.exec<{ schema_version: number }>("SELECT schema_version FROM schema_meta WHERE singleton = 1").toArray()[0]?.schema_version;
    if (version !== undefined && version !== 1) throw new Error(`Unsupported storage schema version ${version}`);
    if (version === 1) return;
    sql.exec(`CREATE TABLE show_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), show_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0), record_json TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE episodes (
      episode_id TEXT PRIMARY KEY, guid TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE source_assets (
      object_key TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('present', 'delete_claimed', 'deleted', 'missing')),
      claim_operation_id TEXT, record_json TEXT NOT NULL,
      CHECK (state NOT IN ('delete_claimed', 'deleted') OR claim_operation_id IS NOT NULL),
      CHECK (state != 'present' OR claim_operation_id IS NULL)
    )`);
    sql.exec("CREATE INDEX source_assets_claim_idx ON source_assets (claim_operation_id)");
    sql.exec(`CREATE TABLE publication_outcomes (
      target TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'blocked', 'failed')),
      record_json TEXT NOT NULL
    )`);
    sql.exec("CREATE TABLE delivery_refs (target TEXT PRIMARY KEY, record_json TEXT NOT NULL)");
    sql.exec("CREATE TABLE source_pins (object_key TEXT NOT NULL, execution_id TEXT NOT NULL, PRIMARY KEY (object_key, execution_id))");
    sql.exec("INSERT INTO schema_meta (singleton, schema_version) VALUES (1, 1)");
  });
}
