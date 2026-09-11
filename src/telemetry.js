import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { estimateCost } from './prices.js';

const usageOf = (usage = {}) => ({
  inputTokens: Number(usage.input_tokens || 0),
  cachedInputTokens: Number(usage.cached_input_tokens || 0),
  cacheWriteInputTokens: Number(usage.cache_write_input_tokens || 0),
  outputTokens: Number(usage.output_tokens || 0),
  reasoningOutputTokens: Number(usage.reasoning_output_tokens || 0),
  totalTokens: Number(usage.total_tokens || 0)
});

export function modelFrom(record) {
  const payload = record.payload || {};
  return payload.model || payload.state?.model || payload.thread_settings?.model || payload.collaboration_mode?.settings?.model || null;
}

export function parseTelemetryLine(line) {
  const record = JSON.parse(line);
  const payload = record.payload || {};
  if (record.type === 'token_usage_record' && payload.usage) {
    const threadId = payload.thread_id || null;
    return { type: 'usage', at: record.timestamp, ordinal: record.ordinal, sessionId: payload.session_id, ...(threadId ? { threadId } : {}), turnId: payload.turn_id, rootTurnId: payload.root_turn_id, responseId: payload.response_id, usage: usageOf(payload.usage) };
  }
  if (record.type === 'turn_context') return { type: 'turn', at: record.timestamp, sessionId: payload.session_id, turnId: payload.turn_id, rootTurnId: payload.root_turn_id, model: modelFrom(record), effort: payload.effort || null };
  if (record.type === 'world_state') return { type: 'world', at: record.timestamp, sessionId: payload.session_id, model: modelFrom(record) };
  if (record.type === 'session_meta') {
    const threadSource = payload.thread_source || null;
    const threadId = payload.thread_id || payload.id || null;
    return { type: 'session', at: record.timestamp, sessionId: payload.session_id || payload.id, ...(threadId ? { threadId } : {}), model: payload.model || payload.base_instructions?.provenance?.model || null, ...(threadSource ? { threadSource } : {}) };
  }
  return { type: 'ignored' };
}

export class TelemetryStore {
  constructor(databasePath) {
    this.db = new DatabaseSync(databasePath);
    const schemaVersion = this.db.prepare('PRAGMA user_version').get().user_version;
    this.needsSessionSourceBackfill = schemaVersion < 5;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cursors (source_file TEXT PRIMARY KEY, byte_offset INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, first_seen_at TEXT, last_seen_at TEXT, fallback_model TEXT, source_kind TEXT, thread_source TEXT);
      CREATE TABLE IF NOT EXISTS threads (thread_id TEXT PRIMARY KEY, session_id TEXT, thread_source TEXT, first_seen_at TEXT, last_seen_at TEXT, source_kind TEXT);
      CREATE TABLE IF NOT EXISTS turns (turn_id TEXT PRIMARY KEY, session_id TEXT, root_turn_id TEXT, model TEXT, effort TEXT, seen_at TEXT);
      CREATE TABLE IF NOT EXISTS world_models (session_id TEXT PRIMARY KEY, model TEXT, seen_at TEXT);
      CREATE TABLE IF NOT EXISTS usage_events (
        event_key TEXT PRIMARY KEY, response_id TEXT UNIQUE, session_id TEXT, thread_id TEXT, turn_id TEXT, root_turn_id TEXT, occurred_at TEXT,
        model TEXT, model_resolution TEXT, input_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER,
        output_tokens INTEGER, reasoning_output_tokens INTEGER, total_tokens INTEGER,
        cost_input REAL, cost_cached REAL, cost_output REAL, cost_total REAL, price_version TEXT, source_file TEXT, source_offset INTEGER
      );
    `);
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all();
    if (!sessionColumns.some((column) => column.name === 'thread_source')) this.db.exec('ALTER TABLE sessions ADD COLUMN thread_source TEXT');
    const usageColumns = this.db.prepare('PRAGMA table_info(usage_events)').all();
    if (!usageColumns.some((column) => column.name === 'effort')) this.db.exec('ALTER TABLE usage_events ADD COLUMN effort TEXT');
    if (!usageColumns.some((column) => column.name === 'thread_id')) this.db.exec('ALTER TABLE usage_events ADD COLUMN thread_id TEXT');
    if (schemaVersion < 2) {
      this.db.exec('DELETE FROM cursors; PRAGMA user_version = 2');
    }
  }
  close() { this.db.close(); }
  cursor(file) { return this.db.prepare('SELECT byte_offset FROM cursors WHERE source_file = ?').get(file)?.byte_offset || 0; }
  setCursor(file, offset) { this.db.prepare(`INSERT INTO cursors(source_file, byte_offset, updated_at) VALUES (?, ?, ?) ON CONFLICT(source_file) DO UPDATE SET byte_offset=excluded.byte_offset, updated_at=excluded.updated_at`).run(file, offset, new Date().toISOString()); }
  upsertSession(event, sourceKind) {
    this.db.prepare(`INSERT INTO sessions(session_id, first_seen_at, last_seen_at, fallback_model, source_kind) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, fallback_model=COALESCE(excluded.fallback_model, sessions.fallback_model), source_kind=excluded.source_kind`).run(event.sessionId, event.at, event.at, event.model || null, sourceKind);
  }
  upsertThread(event, sourceKind) {
    if (!event.threadId) return;
    this.db.prepare(`INSERT INTO threads(thread_id, session_id, thread_source, first_seen_at, last_seen_at, source_kind) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET session_id=COALESCE(excluded.session_id, threads.session_id), thread_source=COALESCE(excluded.thread_source, threads.thread_source), last_seen_at=excluded.last_seen_at, source_kind=excluded.source_kind`).run(event.threadId, event.sessionId || null, event.threadSource || null, event.at || null, event.at || null, sourceKind);
  }
  backfillUsageThread(event) {
    if (!event.threadId) return 0;
    const key = event.responseId || `${event.sessionId}:${event.turnId}:${event.at}:${event.ordinal}`;
    return this.db.prepare(`UPDATE usage_events SET thread_id = COALESCE(thread_id, ?) WHERE event_key = ? OR response_id = ?`).run(event.threadId, key, event.responseId || null).changes;
  }
  ingest(line, sourceFile, sourceKind, offset) {
    let event;
    try { event = parseTelemetryLine(line); } catch { return false; }
    if (event.type === 'ignored') return false;
    if (event.type === 'turn') {
      if (!event.turnId) return false;
      this.db.prepare(`INSERT INTO turns(turn_id, session_id, root_turn_id, model, effort, seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET model=COALESCE(excluded.model, turns.model), effort=COALESCE(excluded.effort, turns.effort), seen_at=excluded.seen_at`).run(event.turnId, event.sessionId || null, event.rootTurnId || null, event.model || null, event.effort || null, event.at || null);
      this.db.prepare('UPDATE usage_events SET effort = COALESCE(?, effort) WHERE turn_id = ?').run(event.effort, event.turnId);
      return true;
    }
    if (!event.sessionId) return false;
    if (event.type === 'session') {
      this.upsertSession(event, sourceKind);
      this.upsertThread(event, sourceKind);
      return true;
    }
    this.upsertSession({ ...event, model: null, threadSource: null }, sourceKind);
    if (event.type === 'world') { this.db.prepare(`INSERT INTO world_models(session_id, model, seen_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET model=excluded.model, seen_at=excluded.seen_at WHERE excluded.seen_at >= world_models.seen_at`).run(event.sessionId, event.model, event.at); return true; }
    const turn = this.db.prepare('SELECT model, effort FROM turns WHERE turn_id = ?').get(event.turnId);
    const world = this.db.prepare('SELECT model FROM world_models WHERE session_id = ?').get(event.sessionId);
    const session = this.db.prepare('SELECT fallback_model FROM sessions WHERE session_id = ?').get(event.sessionId);
    const model = turn?.model || world?.model || session?.fallback_model || 'unknown';
    const resolution = turn?.model ? 'turn_context' : world?.model ? 'world_state' : session?.fallback_model ? 'session_meta' : 'unknown';
    const cost = estimateCost(event.usage, model);
    const key = event.responseId || `${event.sessionId}:${event.turnId}:${event.at}:${event.ordinal}`;
    const duplicate = this.db.prepare('SELECT 1 FROM usage_events WHERE event_key = ? OR response_id = ?').get(key, event.responseId || null);
    const result = this.db.prepare(`INSERT INTO usage_events(event_key, response_id, session_id, thread_id, turn_id, root_turn_id, occurred_at, model, model_resolution, effort, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens, cost_input, cost_cached, cost_output, cost_total, price_version, source_file, source_offset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET effort=COALESCE(excluded.effort, usage_events.effort), thread_id=COALESCE(excluded.thread_id, usage_events.thread_id)`).run(key, event.responseId || null, event.sessionId, event.threadId || null, event.turnId, event.rootTurnId, event.at, model, resolution, turn?.effort || null, event.usage.inputTokens, event.usage.cachedInputTokens, event.usage.cacheWriteInputTokens, event.usage.outputTokens, event.usage.reasoningOutputTokens, event.usage.totalTokens, cost.input, cost.cached, cost.output, cost.total, cost.priceVersion, sourceFile, offset);
    return !duplicate && result.changes > 0;
  }
  async backfillSessionSources(roots) {
    if (!this.needsSessionSourceBackfill) return 0;
    const updated = await backfillThreadSources(this, roots);
    this.db.exec('PRAGMA user_version = 5');
    this.needsSessionSourceBackfill = false;
    return updated;
  }
  timeWhere(alias, range) { return range ? { sql: ` WHERE ${alias}.occurred_at >= ? AND ${alias}.occurred_at < ?`, params: [range.from, range.to] } : { sql: '', params: [] }; }
  overview(range) {
    const where = this.timeWhere('usage_events', range);
    return this.db.prepare(`SELECT COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(cached_input_tokens),0) AS cachedInputTokens, COALESCE(SUM(input_tokens - cached_input_tokens),0) AS uncachedInputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cost_total),0) AS costTotal, MAX(occurred_at) AS lastEventAt FROM usage_events${where.sql}`).get(...where.params);
  }
  sessions(limit = 100, options = {}) {
    const { titleCatalogPath, range = options.from && options.to ? options : null } = options;
    const where = this.timeWhere('usage', range);
    const sessions = this.db.prepare(`SELECT usage.session_id AS sessionId, MAX(usage.occurred_at) AS lastEventAt, CASE WHEN COUNT(DISTINCT usage.model) = 1 THEN MAX(usage.model) ELSE 'mixed' END AS model, COUNT(*) AS calls, SUM(CASE WHEN threads.thread_source = 'subagent' THEN 1 ELSE 0 END) AS subagentCalls, SUM(usage.input_tokens) AS inputTokens, SUM(usage.cached_input_tokens) AS cachedInputTokens, SUM(usage.input_tokens - usage.cached_input_tokens) AS uncachedInputTokens, SUM(usage.output_tokens) AS outputTokens, SUM(usage.total_tokens) AS totalTokens, SUM(usage.cost_input) AS costInput, SUM(usage.cost_cached) AS costCached, SUM(usage.cost_output) AS costOutput, SUM(usage.cost_total) AS costTotal FROM usage_events AS usage LEFT JOIN threads ON threads.thread_id = usage.thread_id${where.sql} GROUP BY usage.session_id ORDER BY lastEventAt DESC LIMIT ?`).all(...where.params, limit);
    const titles = new Map();
    if (titleCatalogPath && sessions.length) {
      let catalog;
      try {
        catalog = new DatabaseSync(titleCatalogPath, { readOnly: true });
        const titleFor = catalog.prepare('SELECT display_title FROM local_thread_catalog WHERE thread_id = ?');
        for (const { sessionId } of sessions) {
          const title = titleFor.get(sessionId)?.display_title;
          if (typeof title === 'string' && title.trim()) titles.set(sessionId, title.trim());
        }
      } catch {
        // The catalog is optional and may be unavailable while Codex updates it.
      } finally {
        catalog?.close();
      }
    }
    return sessions.map((session) => ({ ...session, displayTitle: titles.get(session.sessionId) || session.sessionId }));
  }
  session(id, range) {
    const params = [id, ...(range ? [range.from, range.to] : [])];
    const condition = range ? ' WHERE usage.session_id = ? AND usage.occurred_at >= ? AND usage.occurred_at < ?' : ' WHERE usage.session_id = ?';
    return this.db.prepare(`SELECT usage.event_key AS eventKey, usage.occurred_at AS occurredAt, usage.thread_id AS threadId, usage.model, usage.model_resolution AS modelResolution, usage.effort, usage.input_tokens AS inputTokens, usage.cached_input_tokens AS cachedInputTokens, usage.input_tokens - usage.cached_input_tokens AS uncachedInputTokens, usage.output_tokens AS outputTokens, usage.reasoning_output_tokens AS reasoningOutputTokens, usage.total_tokens AS totalTokens, usage.cost_input AS costInput, usage.cost_cached AS costCached, usage.cost_output AS costOutput, usage.cost_total AS costTotal, threads.thread_source AS threadSource FROM usage_events AS usage LEFT JOIN threads ON threads.thread_id = usage.thread_id${condition} ORDER BY usage.occurred_at DESC LIMIT 250`).all(...params).map((row) => ({ ...row, isSubagent: row.threadSource == null ? null : row.threadSource === 'subagent' }));
  }
}

async function filesUnder(directory) {
  let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return []; }
  const nested = await Promise.all(entries.map(async (entry) => { const file = path.join(directory, entry.name); return entry.isDirectory() ? filesUnder(file) : entry.name.endsWith('.jsonl') ? [file] : []; }));
  return nested.flat();
}

export async function backfillThreadSources(store, roots) {
  let updated = 0;
  for (const root of roots) {
    for (const file of await filesUnder(root.directory)) {
      const input = createReadStream(file, { encoding: 'utf8' });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let event;
          try { event = parseTelemetryLine(line); } catch { continue; }
          if (event.type === 'session' && event.sessionId) {
            store.upsertSession(event, root.kind);
            store.upsertThread(event, root.kind);
            updated += event.threadId && event.threadSource ? 1 : 0;
          } else if (event.type === 'usage' && event.threadId) {
            updated += store.backfillUsageThread(event);
          }
        }
      } finally {
        lines.close();
        input.destroy();
      }
    }
  }
  return updated;
}

export class TelemetryWatcher {
  constructor(store, roots) { this.store = store; this.roots = roots; }
  async scan() {
    let additions = 0;
    for (const root of this.roots) for (const file of await filesUnder(root.directory)) additions += await this.scanFile(file, root.kind);
    return additions;
  }
  async scanFile(file, kind) {
    const stat = await fs.stat(file); let offset = this.store.cursor(file); if (stat.size < offset) offset = 0;
    if (stat.size === offset) return 0;
    const handle = await fs.open(file, 'r'); let additions = 0; let readOffset = offset; let pending = Buffer.alloc(0);
    try {
      while (readOffset < stat.size) {
        const size = Math.min(1024 * 1024, stat.size - readOffset); const buffer = Buffer.alloc(size); const { bytesRead } = await handle.read(buffer, 0, size, readOffset); if (!bytesRead) break;
        readOffset += bytesRead;
        const data = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        let lineStart = 0; let newline;
        while ((newline = data.indexOf(0x0a, lineStart)) !== -1) {
          const line = data.subarray(lineStart, newline);
          additions += this.store.ingest(line.toString('utf8'), file, kind, offset) ? 1 : 0;
          offset += line.length + 1;
          lineStart = newline + 1;
        }
        pending = data.subarray(lineStart);
        this.store.setCursor(file, offset);
      }
    } finally { await handle.close(); }
    return additions;
  }
}
