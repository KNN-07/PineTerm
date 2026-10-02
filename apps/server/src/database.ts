import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type AppDatabase = Database.Database;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'security_and_invalidation',
    sql: `
      CREATE TABLE sessions (
        id_hash TEXT PRIMARY KEY CHECK(length(id_hash) = 64),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at > created_at)
      ) STRICT;
      CREATE INDEX sessions_expiry ON sessions(expires_at);
      CREATE TABLE login_attempts (
        bucket TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        attempts INTEGER NOT NULL CHECK(attempts >= 0)
      ) STRICT;
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
        scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
        executor_id TEXT REFERENCES executors(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_used_at INTEGER
      ) STRICT;
      CREATE INDEX api_keys_executor ON api_keys(executor_id);
      CREATE TABLE integration_settings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL CHECK(revision > 0),
        public_config_json TEXT NOT NULL CHECK(json_valid(public_config_json)),
        encrypted_secrets TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE invalidation_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX invalidation_events_age ON invalidation_events(created_at);
    `,
  },
  {
    version: 2,
    name: 'workspaces_scripts_and_market_history',
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        vela_state_json TEXT NOT NULL CHECK(json_valid(vela_state_json)),
        ui_state_json TEXT NOT NULL CHECK(json_valid(ui_state_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE watchlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE watchlist_items (
        id TEXT PRIMARY KEY,
        watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 0),
        provider TEXT NOT NULL CHECK(provider IN ('binance', 'coinbase', 'csv')),
        symbol TEXT NOT NULL,
        UNIQUE(watchlist_id, position),
        UNIQUE(watchlist_id, provider, symbol)
      ) STRICT;
      CREATE TABLE scripts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE script_revisions (
        id TEXT PRIMARY KEY,
        script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        source TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        language_version INTEGER NOT NULL CHECK(language_version IN (5, 6)),
        inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
        props_json TEXT NOT NULL CHECK(json_valid(props_json)),
        created_at INTEGER NOT NULL,
        UNIQUE(script_id, revision)
      ) STRICT;
      CREATE TRIGGER script_revision_immutable_update BEFORE UPDATE ON script_revisions
        BEGIN SELECT RAISE(ABORT, 'Script revisions are immutable'); END;
      CREATE TRIGGER script_revision_immutable_delete BEFORE DELETE ON script_revisions
        BEGIN SELECT RAISE(ABORT, 'Script revisions are immutable'); END;
      CREATE TABLE datasets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        quote_currency TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        tick_size TEXT NOT NULL,
        quantity_step TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        row_count INTEGER NOT NULL CHECK(row_count > 0),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE dataset_bars (
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        time INTEGER NOT NULL,
        open REAL NOT NULL CHECK(open > 0),
        high REAL NOT NULL CHECK(high >= open AND high >= close AND high >= low),
        low REAL NOT NULL CHECK(low > 0 AND low <= open AND low <= close),
        close REAL NOT NULL CHECK(close > 0),
        volume REAL NOT NULL CHECK(volume >= 0),
        PRIMARY KEY(dataset_id, time)
      ) STRICT;
      CREATE TABLE bar_cache (
        provider TEXT NOT NULL CHECK(provider IN ('binance', 'coinbase')),
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        time INTEGER NOT NULL,
        open REAL NOT NULL CHECK(open > 0),
        high REAL NOT NULL CHECK(high >= open AND high >= close AND high >= low),
        low REAL NOT NULL CHECK(low > 0 AND low <= open AND low <= close),
        close REAL NOT NULL CHECK(close > 0),
        volume REAL NOT NULL CHECK(volume >= 0),
        confirmed_at INTEGER NOT NULL,
        PRIMARY KEY(provider, symbol, timeframe, time)
      ) STRICT;
      CREATE TABLE bar_gaps (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        from_time INTEGER NOT NULL,
        to_time INTEGER NOT NULL CHECK(to_time > from_time),
        detected_at INTEGER NOT NULL,
        resolved_at INTEGER
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: 'backtests_paper_accounting_and_replay',
    sql: `
      CREATE TABLE backtest_jobs (
        id TEXT PRIMARY KEY,
        script_revision_id TEXT NOT NULL REFERENCES script_revisions(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        request_json TEXT NOT NULL CHECK(json_valid(request_json)),
        diagnostic_json TEXT CHECK(diagnostic_json IS NULL OR json_valid(diagnostic_json)),
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      ) STRICT;
      CREATE INDEX backtest_jobs_state ON backtest_jobs(state, created_at);
      CREATE TABLE backtest_results (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE REFERENCES backtest_jobs(id) ON DELETE RESTRICT,
        engine_version TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
        resolved_config_json TEXT NOT NULL CHECK(json_valid(resolved_config_json)),
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TRIGGER backtest_result_immutable_update BEFORE UPDATE ON backtest_results
        BEGIN SELECT RAISE(ABORT, 'Backtest results are immutable'); END;
      CREATE TRIGGER backtest_result_immutable_delete BEFORE DELETE ON backtest_results
        BEGIN SELECT RAISE(ABORT, 'Backtest results are immutable'); END;
      CREATE TABLE backtest_snapshots (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES backtest_jobs(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        from_time INTEGER NOT NULL,
        to_time INTEGER NOT NULL,
        bars_json TEXT NOT NULL CHECK(json_valid(bars_json)),
        symbol_info_json TEXT NOT NULL CHECK(json_valid(symbol_info_json)),
        snapshot_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(job_id, provider, symbol, timeframe)
      ) STRICT;
      CREATE TABLE paper_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('live', 'replay')),
        quote_currency TEXT NOT NULL,
        initial_balance TEXT NOT NULL,
        cash_balance TEXT NOT NULL,
        reserved_cash TEXT NOT NULL,
        commission_bps TEXT NOT NULL,
        slippage_bps TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE paper_orders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE RESTRICT,
        accepted_sequence INTEGER NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
        type TEXT NOT NULL CHECK(type IN ('market', 'limit', 'stop')),
        quantity TEXT NOT NULL,
        limit_price TEXT,
        stop_price TEXT,
        reserved_cash TEXT NOT NULL,
        reserved_quantity TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('open', 'filled', 'cancelled', 'rejected')),
        waiting_reason TEXT,
        accepted_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(account_id, idempotency_key)
      ) STRICT;
      CREATE INDEX paper_orders_open ON paper_orders(state, provider, symbol, accepted_sequence);
      CREATE TABLE paper_positions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        quantity TEXT NOT NULL,
        reserved_quantity TEXT NOT NULL,
        cost_basis TEXT NOT NULL,
        realized_pnl TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        UNIQUE(account_id, provider, symbol)
      ) STRICT;
      CREATE TABLE paper_fills (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE REFERENCES paper_orders(id) ON DELETE RESTRICT,
        account_id TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE RESTRICT,
        quantity TEXT NOT NULL,
        price TEXT NOT NULL,
        fee TEXT NOT NULL,
        currency TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE paper_ledger (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE RESTRICT,
        fill_id TEXT REFERENCES paper_fills(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK(kind IN ('initial_balance', 'fill', 'reset')),
        cash_delta TEXT NOT NULL,
        cash_balance TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        occurred_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE paper_quote_watermarks (
        account_id TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, provider, symbol)
      ) STRICT;
      CREATE TABLE replay_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL UNIQUE REFERENCES paper_accounts(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK(state IN ('active', 'stopped')),
        markets_json TEXT NOT NULL CHECK(json_valid(markets_json)),
        base_timeframe TEXT NOT NULL,
        from_time INTEGER NOT NULL,
        to_time INTEGER NOT NULL,
        cursor_time INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 4,
    name: 'alerts_execution_and_agent_metadata',
    sql: `
      CREATE TABLE webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('quote', 'bar-close')),
        frequency TEXT NOT NULL CHECK(frequency IN ('once', 'once_per_bar')),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        script_revision_id TEXT REFERENCES script_revisions(id) ON DELETE RESTRICT,
        definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
        warmup_from INTEGER,
        evaluation_watermark INTEGER,
        evaluation_state_json TEXT NOT NULL CHECK(json_valid(evaluation_state_json)),
        paused_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE alert_events (
        id TEXT PRIMARY KEY,
        alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
        alert_revision INTEGER NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE alert_deliveries (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES alert_events(id) ON DELETE RESTRICT,
        destination_kind TEXT NOT NULL CHECK(destination_kind IN ('webhook', 'telegram')),
        destination_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'sending', 'delivered', 'failed')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        next_attempt_at INTEGER NOT NULL,
        last_status INTEGER,
        last_error TEXT,
        delivered_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(event_id, destination_kind, destination_id)
      ) STRICT;
      CREATE INDEX alert_deliveries_due ON alert_deliveries(state, next_attempt_at);
      CREATE TABLE telegram_state (
        integration_id TEXT PRIMARY KEY REFERENCES integration_settings(id) ON DELETE CASCADE,
        update_offset INTEGER NOT NULL CHECK(update_offset >= 0),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE executors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        claims_paused_reason TEXT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      ) STRICT;
      CREATE TABLE execution_policy (
        id TEXT PRIMARY KEY,
        singleton INTEGER NOT NULL UNIQUE CHECK(singleton = 1),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        revision INTEGER NOT NULL CHECK(revision > 0),
        policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE live_intents (
        id TEXT PRIMARY KEY,
        executor_id TEXT NOT NULL REFERENCES executors(id) ON DELETE RESTRICT,
        creator_key_id TEXT REFERENCES api_keys(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
        type TEXT NOT NULL CHECK(type IN ('market', 'limit')),
        quantity TEXT NOT NULL,
        limit_price TEXT,
        quote_currency TEXT NOT NULL,
        reference_price TEXT NOT NULL,
        maximum_deviation_bps TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'claimed', 'acknowledged', 'partially_filled', 'filled', 'rejected', 'cancelled', 'expired', 'unknown')),
        cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0, 1)),
        lease_token_hash TEXT,
        lease_expires_at INTEGER,
        external_order_id TEXT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(executor_id, idempotency_key)
      ) STRICT;
      CREATE INDEX live_intents_claimable ON live_intents(executor_id, state, created_at);
      CREATE TABLE executor_reports (
        id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL REFERENCES live_intents(id) ON DELETE RESTRICT,
        executor_id TEXT NOT NULL REFERENCES executors(id) ON DELETE RESTRICT,
        external_report_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at INTEGER NOT NULL,
        UNIQUE(executor_id, external_report_id)
      ) STRICT;
      CREATE TABLE executor_fills (
        id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL REFERENCES live_intents(id) ON DELETE RESTRICT,
        executor_id TEXT NOT NULL REFERENCES executors(id) ON DELETE RESTRICT,
        external_fill_id TEXT NOT NULL,
        quantity TEXT NOT NULL,
        price TEXT NOT NULL,
        fee TEXT NOT NULL,
        currency TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(executor_id, external_fill_id)
      ) STRICT;
      CREATE TABLE risk_reservations (
        id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL UNIQUE REFERENCES live_intents(id) ON DELETE RESTRICT,
        quote_currency TEXT NOT NULL,
        requested_notional TEXT NOT NULL,
        retained_notional TEXT NOT NULL,
        pending_capacity INTEGER NOT NULL CHECK(pending_capacity IN (0, 1)),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      ) STRICT;
      CREATE INDEX risk_reservations_window ON risk_reservations(quote_currency, created_at);
      CREATE TABLE execution_audit (
        id TEXT PRIMARY KEY,
        intent_id TEXT REFERENCES live_intents(id) ON DELETE RESTRICT,
        executor_id TEXT REFERENCES executors(id) ON DELETE RESTRICT,
        type TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        storage_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      ) STRICT;
      CREATE TABLE agent_drafts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
        script_id TEXT REFERENCES scripts(id) ON DELETE RESTRICT,
        base_revision_id TEXT REFERENCES script_revisions(id) ON DELETE RESTRICT,
        source TEXT NOT NULL,
        diagnostic_json TEXT CHECK(diagnostic_json IS NULL OR json_valid(diagnostic_json)),
        applied_revision_id TEXT REFERENCES script_revisions(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 5,
    name: 'paper_acceptance_references_and_quote_deduplication',
    sql: `
      ALTER TABLE paper_orders ADD COLUMN accepted_reference_event_id TEXT;
      ALTER TABLE paper_orders ADD COLUMN accepted_reference_observed_at INTEGER;
      CREATE TABLE paper_processed_quotes (
        account_id TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, provider, symbol, source_event_id)
      ) STRICT;
      CREATE INDEX paper_fills_account ON paper_fills(account_id, created_at, id);
      CREATE INDEX paper_ledger_account ON paper_ledger(account_id, occurred_at, id);
    `,
  },
  {
    version: 6,
    name: 'durable_alert_archive',
    sql: `
      ALTER TABLE alerts ADD COLUMN archived_at INTEGER;
      CREATE INDEX alerts_active ON alerts(enabled, archived_at);
      CREATE INDEX alert_events_history ON alert_events(alert_id, created_at, id);
    `,
  },
  {
    version: 7,
    name: 'durable_scoped_execution_handoff',
    sql: `
      ALTER TABLE live_intents ADD COLUMN encrypted_lease_token TEXT;
      ALTER TABLE live_intents ADD COLUMN reference_observed_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE live_intents ADD COLUMN source_event_id TEXT REFERENCES alert_events(id) ON DELETE RESTRICT;
      ALTER TABLE live_intents ADD COLUMN min_execution_price TEXT;
      ALTER TABLE live_intents ADD COLUMN max_execution_price TEXT;
      ALTER TABLE live_intents ADD COLUMN quantity_step TEXT NOT NULL DEFAULT '1';
      ALTER TABLE live_intents ADD COLUMN tick_size TEXT NOT NULL DEFAULT '0.01';
      ALTER TABLE risk_reservations ADD COLUMN unit_risk_price TEXT NOT NULL DEFAULT '0';
      ALTER TABLE risk_reservations ADD COLUMN submitted_at INTEGER;
      ALTER TABLE executor_reports ADD COLUMN response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json));
      CREATE UNIQUE INDEX live_intents_source_event ON live_intents(source_event_id) WHERE source_event_id IS NOT NULL;
      CREATE TABLE alert_live_actions (
        event_id TEXT PRIMARY KEY REFERENCES alert_events(id) ON DELETE RESTRICT,
        action_json TEXT NOT NULL CHECK(json_valid(action_json)),
        state TEXT NOT NULL CHECK(state IN ('pending', 'created', 'failed')),
        intent_id TEXT REFERENCES live_intents(id) ON DELETE RESTRICT,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      ) STRICT;
      CREATE INDEX alert_live_actions_pending ON alert_live_actions(state, created_at);
      CREATE INDEX executor_fills_intent ON executor_fills(intent_id);
      CREATE INDEX execution_audit_history ON execution_audit(created_at, id);
    `,
  },
  {
    version: 8,
    name: 'restricted_agent_stream_and_validated_drafts',
    sql: `
      ALTER TABLE agent_drafts ADD COLUMN name TEXT NOT NULL DEFAULT 'Generated draft';
      ALTER TABLE agent_drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE agent_drafts ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(inputs_json));
      ALTER TABLE agent_drafts ADD COLUMN props_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(props_json));
      ALTER TABLE agent_drafts ADD COLUMN validation_hash TEXT;
      ALTER TABLE agent_drafts ADD COLUMN apply_hash TEXT;
      ALTER TABLE agent_drafts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE agent_stream_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
        event_json TEXT NOT NULL CHECK(json_valid(event_json)),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX agent_stream_session ON agent_stream_events(session_id, sequence);
      CREATE INDEX agent_drafts_session ON agent_drafts(session_id, created_at, id);
    `,
  },
];

export function openDatabase(dataDir: string, clock: () => number): AppDatabase {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = join(dataDir, 'pineterm.sqlite');
  const db = new Database(filename);
  try {
    chmodSync(filename, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT`);
    db.transaction(() => {
      const applied = db.prepare<[], { version: number; name: string }>('SELECT version, name FROM schema_migrations ORDER BY version').all();
      if (applied.some((row, index) => row.version !== migrations[index]?.version || row.name !== migrations[index]?.name)) {
        throw new Error('Database migrations are newer than or incompatible with this server. Use the matching PineTerm source revision.');
      }
      const record = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)');
      for (const migration of migrations.slice(applied.length)) {
        db.exec(migration.sql);
        record.run(migration.version, migration.name, clock());
      }
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
