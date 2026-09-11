import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  appendFile,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { estimateCost } from '../src/prices.js';
import {
  backfillThreadSources,
  modelFrom,
  parseTelemetryLine,
  TelemetryStore,
  TelemetryWatcher
} from '../src/telemetry.js';

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(fixtureDirectory, '..');

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function duplicateSigintResult() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-shutdown-home-'));
  await mkdir(path.join(home, '.codex', 'sessions'), { recursive: true });
  await mkdir(path.join(home, '.codex', 'archived_sessions'), { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: projectDirectory,
    env: { ...process.env, HOME: home, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`server did not start: ${stdout}`)), 5000);
      const onData = () => {
        if (!stdout.includes(`127.0.0.1:${port}`)) return;
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        resolve();
      };
      child.stdout.on('data', onData);
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`server exited before start: ${code}/${signal}\n${stderr}`)));
    });

    const eventResponse = await new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${port}/events`, (response) => {
        if (response.statusCode === 200) resolve(response);
        else reject(new Error(`SSE status was ${response.statusCode}`));
      });
      request.once('error', reject);
    });

    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        eventResponse.destroy();
        resolve({ ...value, stdout, stderr });
      };
      child.once('close', (code, signal) => finish({ code, signal }));
      child.kill('SIGINT');
      child.kill('SIGINT');
      setTimeout(() => eventResponse.destroy(), 100);
      setTimeout(() => {
        child.kill('SIGTERM');
        finish({ code: null, signal: 'timeout' });
      }, 3000).unref();
    });
    return result;
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    await rm(home, { recursive: true, force: true });
  }
}

function record(type, payload, timestamp = '2026-09-10T12:00:00.000Z', extra = {}) {
  return JSON.stringify({ type, timestamp, payload, ...extra });
}

function usageRecord({
  sessionId,
  threadId,
  turnId,
  responseId,
  inputTokens = 0,
  cachedInputTokens = 0,
  cacheWriteInputTokens = 0,
  outputTokens = 0,
  reasoningOutputTokens = 0,
  totalTokens = inputTokens + outputTokens,
  timestamp = '2026-09-10T12:00:00.000Z',
  ordinal = 1,
  extraPayload = {}
}) {
  return record('token_usage_record', {
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    root_turn_id: `${turnId}-root`,
    response_id: responseId,
    usage: {
      input_tokens: inputTokens,
      cached_input_tokens: cachedInputTokens,
      cache_write_input_tokens: cacheWriteInputTokens,
      output_tokens: outputTokens,
      reasoning_output_tokens: reasoningOutputTokens,
      total_tokens: totalTokens
    },
    ...extraPayload
  }, timestamp, { ordinal });
}

async function temporaryStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-test-'));
  const store = new TelemetryStore(path.join(directory, 'telemetry.sqlite'));
  return { directory, store };
}

async function closeTemporaryStore(directory, store) {
  store.close();
  await rm(directory, { recursive: true, force: true });
}

function createThreadTitleCatalog(databasePath, entries) {
  const catalog = new DatabaseSync(databasePath);
  catalog.exec(`
    CREATE TABLE local_thread_catalog (
      thread_id TEXT PRIMARY KEY,
      display_title TEXT,
      source_updated_at TEXT,
      summary TEXT
    );
  `);
  const insert = catalog.prepare('INSERT INTO local_thread_catalog(thread_id, display_title, source_updated_at, summary) VALUES (?, ?, ?, ?)');
  for (const entry of entries) insert.run(entry.threadId, entry.displayTitle, entry.sourceUpdatedAt || '2026-09-10T12:00:00.000Z', entry.summary || 'catalog-only field');
  catalog.close();
}

test('parseTelemetryLine normalizes usage counters without retaining raw content', () => {
  const parsed = parseTelemetryLine(usageRecord({
    sessionId: 'session-parser',
    turnId: 'turn-parser',
    responseId: 'response-parser',
    inputTokens: 120,
    cachedInputTokens: 30,
    cacheWriteInputTokens: 4,
    outputTokens: 80,
    reasoningOutputTokens: 12,
    totalTokens: 200,
    ordinal: 7
  }));

  assert.deepEqual(parsed, {
    type: 'usage',
    at: '2026-09-10T12:00:00.000Z',
    ordinal: 7,
    sessionId: 'session-parser',
    turnId: 'turn-parser',
    rootTurnId: 'turn-parser-root',
    responseId: 'response-parser',
    usage: {
      inputTokens: 120,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 4,
      outputTokens: 80,
      reasoningOutputTokens: 12,
      totalTokens: 200
    }
  });
  assert.equal('prompt text' in parsed, false);
});

test('parseTelemetryLine resolves model fields for turn, world and session records', () => {
  const turnRecord = {
    type: 'turn_context',
    timestamp: '2026-09-10T12:01:00.000Z',
    payload: {
      session_id: 'session-model',
      turn_id: 'turn-model',
      root_turn_id: 'root-model',
      collaboration_mode: { settings: { model: 'gpt-6-astra' } },
      effort: 'high',
      message: 'must never be returned'
    }
  };
  const worldRecord = record('world_state', {
    session_id: 'session-model',
    state: { model: 'gpt-5.6-sol' }
  }, '2026-09-10T12:00:30.000Z');
  const sessionRecord = record('session_meta', {
    session_id: 'session-model',
    base_instructions: { provenance: { model: 'gpt-5.6-luna' } },
    instructions: 'must never be returned'
  }, '2026-09-10T11:59:00.000Z');

  assert.deepEqual(parseTelemetryLine(JSON.stringify(turnRecord)), {
    type: 'turn',
    at: '2026-09-10T12:01:00.000Z',
    sessionId: 'session-model',
    turnId: 'turn-model',
    rootTurnId: 'root-model',
    model: 'gpt-6-astra',
    effort: 'high'
  });
  assert.deepEqual(parseTelemetryLine(worldRecord), {
    type: 'world',
    at: '2026-09-10T12:00:30.000Z',
    sessionId: 'session-model',
    model: 'gpt-5.6-sol'
  });
  assert.deepEqual(parseTelemetryLine(sessionRecord), {
    type: 'session',
    at: '2026-09-10T11:59:00.000Z',
    sessionId: 'session-model',
    model: 'gpt-5.6-luna'
  });
  assert.equal(modelFrom(turnRecord), 'gpt-6-astra');
  assert.deepEqual(parseTelemetryLine(record('tool_result', { text: 'private result' })), { type: 'ignored' });
});

test('parseTelemetryLine captures thread_source from session_meta records', () => {
  const parsed = parseTelemetryLine(record('session_meta', {
    id: 'thread-subagent-parser',
    session_id: 'session-subagent-parser',
    thread_source: 'subagent'
  }));

  assert.equal(parsed.type, 'session');
  assert.equal(parsed.sessionId, 'session-subagent-parser');
  assert.equal(parsed.threadId, 'thread-subagent-parser');
  assert.equal(parsed.threadSource, 'subagent');
});

test('TelemetryStore aggregates subagentCalls and classifies each thread after session_meta follows usage', async () => {
  const { directory, store } = await temporaryStore();
  try {
    for (const [sessionId, threadId, threadSource] of [
      ['session-subagent', 'thread-subagent', 'subagent'],
      ['session-main', 'thread-main', 'user']
    ]) {
      assert.equal(store.ingest(usageRecord({
        sessionId,
        threadId,
        turnId: `${sessionId}-turn`,
        responseId: `${sessionId}-response`,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12
      }), `/active/${sessionId}.jsonl`, 'active', 0), true);
    }

    store.ingest(record('session_meta', {
      id: 'thread-subagent',
      session_id: 'session-subagent',
      thread_source: 'subagent'
    }, '2026-09-10T12:01:00.000Z'), '/active/session-subagent.jsonl', 'active', 100);
    store.ingest(record('session_meta', {
      id: 'thread-main',
      session_id: 'session-main',
      thread_source: 'user'
    }, '2026-09-10T12:01:00.000Z'), '/active/session-main.jsonl', 'active', 100);

    const sessions = new Map(store.sessions().map((session) => [session.sessionId, session]));
    assert.equal(sessions.get('session-subagent').subagentCalls, 1);
    assert.equal(sessions.get('session-main').subagentCalls, 0);
    assert.equal(Object.hasOwn(sessions.get('session-subagent'), 'threadSource'), false);
    assert.equal(Object.hasOwn(sessions.get('session-subagent'), 'isSubagent'), false);

    const subagentEvent = store.session('session-subagent')[0];
    assert.equal(subagentEvent.threadId, 'thread-subagent');
    assert.equal(subagentEvent.threadSource, 'subagent');
    assert.equal(subagentEvent.isSubagent, true);
    const mainEvent = store.session('session-main')[0];
    assert.equal(mainEvent.threadId, 'thread-main');
    assert.equal(mainEvent.threadSource, 'user');
    assert.equal(mainEvent.isSubagent, false);
  } finally {
    await closeTemporaryStore(directory, store);
  }
});

test('TelemetryStore classifies subagent usage per thread within a shared session', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const sessionId = 'session-shared';
    store.ingest(record('session_meta', {
      id: 'thread-main',
      session_id: sessionId,
      thread_source: 'user'
    }), '/active/main.jsonl', 'active', 0);
    store.ingest(usageRecord({
      sessionId,
      turnId: 'turn-main',
      responseId: 'response-main',
      extraPayload: { thread_id: 'thread-main' }
    }), '/active/main.jsonl', 'active', 100);

    store.ingest(record('session_meta', {
      id: 'thread-subagent',
      session_id: sessionId,
      thread_source: 'subagent'
    }), '/active/subagent.jsonl', 'active', 0);
    store.ingest(usageRecord({
      sessionId,
      turnId: 'turn-subagent',
      responseId: 'response-subagent',
      extraPayload: { thread_id: 'thread-subagent' }
    }), '/active/subagent.jsonl', 'active', 100);

    const events = new Map(store.session(sessionId).map((event) => [event.eventKey, event]));
    assert.deepEqual({
      threadId: events.get('response-main').threadId,
      threadSource: events.get('response-main').threadSource,
      isSubagent: events.get('response-main').isSubagent
    }, {
      threadId: 'thread-main',
      threadSource: 'user',
      isSubagent: false
    });
    assert.deepEqual({
      threadId: events.get('response-subagent').threadId,
      threadSource: events.get('response-subagent').threadSource,
      isSubagent: events.get('response-subagent').isSubagent
    }, {
      threadId: 'thread-subagent',
      threadSource: 'subagent',
      isSubagent: true
    });
  } finally {
    await closeTemporaryStore(directory, store);
  }
});

test('backfillThreadSources restores historical thread ids and classifications without duplicating metrics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-backfill-'));
  const active = path.join(directory, 'active');
  const archived = path.join(directory, 'archived');
  const storeDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-backfill-store-'));
  const store = new TelemetryStore(path.join(storeDirectory, 'telemetry.sqlite'));
  try {
    await mkdir(active, { recursive: true });
    await mkdir(archived, { recursive: true });

    const sessionId = 'session-backfill-shared';
    for (const [threadId, responseId, inputTokens, outputTokens, sourceFile, kind] of [
      ['thread-backfill-main', 'response-backfill-main', 10, 2, '/historical/main.jsonl', 'active'],
      ['thread-backfill-subagent', 'response-backfill-subagent', 20, 4, '/historical/subagent.jsonl', 'archived']
    ]) {
      assert.equal(store.ingest(usageRecord({
        sessionId,
        turnId: `${threadId}-turn`,
        responseId,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
      }), sourceFile, kind, 0), true);
    }

    await writeFile(path.join(active, 'active.jsonl'), [
      record('session_meta', {
        id: 'thread-backfill-main',
        session_id: sessionId,
        thread_source: 'user'
      }),
      usageRecord({
        sessionId,
        threadId: 'thread-backfill-main',
        turnId: 'thread-backfill-main-turn',
        responseId: 'response-backfill-main',
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12
      }),
      usageRecord({
        sessionId: 'session-not-in-store',
        threadId: 'thread-not-in-store',
        turnId: 'turn-must-not-be-ingested',
        responseId: 'response-must-not-be-ingested',
        inputTokens: 99,
        outputTokens: 99,
        totalTokens: 198
      })
    ].join('\n') + '\n', 'utf8');
    await writeFile(path.join(archived, 'archived.jsonl'), [
      record('session_meta', {
        id: 'thread-backfill-subagent',
        session_id: sessionId,
        thread_source: 'subagent'
      }),
      usageRecord({
        sessionId,
        threadId: 'thread-backfill-subagent',
        turnId: 'thread-backfill-subagent-turn',
        responseId: 'response-backfill-subagent',
        inputTokens: 20,
        outputTokens: 4,
        totalTokens: 24
      })
    ].join('\n') + '\n', 'utf8');

    await backfillThreadSources(store, [
      { directory: active, kind: 'active' },
      { directory: archived, kind: 'archived' }
    ]);

    const calls = () => store.session(sessionId)
      .map(({ eventKey, threadId, threadSource, isSubagent }) => ({ eventKey, threadId, threadSource, isSubagent }))
      .sort((left, right) => left.eventKey.localeCompare(right.eventKey));
    const afterFirstRun = calls();
    assert.deepEqual(afterFirstRun, [
      { eventKey: 'response-backfill-main', threadId: 'thread-backfill-main', threadSource: 'user', isSubagent: false },
      { eventKey: 'response-backfill-subagent', threadId: 'thread-backfill-subagent', threadSource: 'subagent', isSubagent: true }
    ]);
    assert.deepEqual({ calls: store.overview().calls, sessions: store.overview().sessions, inputTokens: store.overview().inputTokens, outputTokens: store.overview().outputTokens }, {
      calls: 2,
      sessions: 1,
      inputTokens: 30,
      outputTokens: 6
    });
    assert.equal(store.sessions().find((session) => session.sessionId === sessionId).subagentCalls, 1);

    await backfillThreadSources(store, [
      { directory: active, kind: 'active' },
      { directory: archived, kind: 'archived' }
    ]);
    const afterSecondRun = calls();
    assert.deepEqual(afterSecondRun, afterFirstRun);
    assert.equal(store.overview().calls, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(storeDirectory, { recursive: true, force: true });
  }
});

test('TelemetryStore resolves model per usage event and aggregates only usage records', async () => {
  const { directory, store } = await temporaryStore();
  try {
    store.ingest(record('session_meta', {
      session_id: 'session-a',
      model: 'gpt-5.6-luna'
    }), '/active/session-a.jsonl', 'active', 0);
    store.ingest(record('world_state', {
      session_id: 'session-a',
      model: 'gpt-5.6-sol'
    }), '/active/session-a.jsonl', 'active', 100);
    store.ingest(record('turn_context', {
      session_id: 'session-a',
      turn_id: 'turn-a',
      root_turn_id: 'root-a',
      model: 'gpt-6-astra',
      effort: 'high'
    }), '/active/session-a.jsonl', 'active', 200);

    assert.equal(store.ingest(usageRecord({
      sessionId: 'session-a',
      turnId: 'turn-a',
      responseId: 'response-turn',
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 130
    }), '/active/session-a.jsonl', 'active', 300), true);
    assert.equal(store.ingest(usageRecord({
      sessionId: 'session-a',
      turnId: 'turn-without-context',
      responseId: 'response-world',
      inputTokens: 200,
      cachedInputTokens: 100,
      outputTokens: 40,
      reasoningOutputTokens: 20,
      totalTokens: 240,
      timestamp: '2026-09-10T12:02:00.000Z'
    }), '/active/session-a.jsonl', 'active', 400), true);
    assert.equal(store.ingest(usageRecord({
      sessionId: 'session-without-model',
      turnId: 'turn-unknown',
      responseId: 'response-unknown',
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      timestamp: '2026-09-10T12:03:00.000Z'
    }), '/active/session-b.jsonl', 'active', 0), true);
    store.ingest(record('session_meta', {
      session_id: 'session-session-fallback',
      model: 'gpt-5.6-luna'
    }), '/active/session-fallback.jsonl', 'active', 0);
    assert.equal(store.ingest(usageRecord({
      sessionId: 'session-session-fallback',
      turnId: 'turn-session-fallback',
      responseId: 'response-session-fallback'
    }), '/active/session-fallback.jsonl', 'active', 100), true);

    const details = store.session('session-a');
    const byEventKey = new Map(details.map((item) => [item.eventKey, item]));
    assert.equal(byEventKey.get('response-turn').model, 'gpt-6-astra');
    assert.equal(byEventKey.get('response-turn').modelResolution, 'turn_context');
    assert.equal(byEventKey.get('response-world').model, 'gpt-5.6-sol');
    assert.equal(byEventKey.get('response-world').modelResolution, 'world_state');
    assert.equal(byEventKey.get('response-turn').uncachedInputTokens, 80);
    assert.equal(byEventKey.get('response-world').uncachedInputTokens, 100);
    assert.equal(byEventKey.get('response-turn').reasoningOutputTokens, 10);
    const fallback = store.session('session-session-fallback');
    assert.equal(fallback[0].model, 'gpt-5.6-luna');
    assert.equal(fallback[0].modelResolution, 'session_meta');

    const overview = store.overview();
    assert.deepEqual({
      calls: overview.calls,
      sessions: overview.sessions,
      inputTokens: overview.inputTokens,
      cachedInputTokens: overview.cachedInputTokens,
      uncachedInputTokens: overview.uncachedInputTokens,
      outputTokens: overview.outputTokens
    }, {
      calls: 4,
      sessions: 3,
      inputTokens: 320,
      cachedInputTokens: 120,
      uncachedInputTokens: 200,
      outputTokens: 80
    });

    const session = store.sessions().find((item) => item.sessionId === 'session-a');
    assert.deepEqual({
      calls: session.calls,
      inputTokens: session.inputTokens,
      cachedInputTokens: session.cachedInputTokens,
      uncachedInputTokens: session.uncachedInputTokens,
      outputTokens: session.outputTokens,
      totalTokens: session.totalTokens
    }, {
      calls: 2,
      inputTokens: 300,
      cachedInputTokens: 120,
      uncachedInputTokens: 180,
      outputTokens: 70,
      totalTokens: 370
    });
  } finally {
    await closeTemporaryStore(directory, store);
  }
});

test('TelemetryStore stores effort on the matching usage event and does not inherit it', async () => {
  const { directory, store } = await temporaryStore();
  try {
    store.ingest(record('turn_context', {
      session_id: 'session-effort',
      turn_id: 'turn-with-effort',
      root_turn_id: 'root-effort',
      model: 'gpt-5.6-sol',
      effort: 'high'
    }), '/active/effort.jsonl', 'active', 0);
    store.ingest(usageRecord({
      sessionId: 'session-effort',
      turnId: 'turn-with-effort',
      responseId: 'response-with-effort',
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13
    }), '/active/effort.jsonl', 'active', 100);
    store.ingest(record('turn_context', {
      session_id: 'session-effort',
      turn_id: 'turn-without-effort',
      root_turn_id: 'root-effort',
      model: 'gpt-5.6-sol'
    }, '2026-09-10T12:01:00.000Z'), '/active/effort.jsonl', 'active', 200);
    store.ingest(usageRecord({
      sessionId: 'session-effort',
      turnId: 'turn-without-effort',
      responseId: 'response-without-effort',
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
      timestamp: '2026-09-10T12:01:01.000Z'
    }), '/active/effort.jsonl', 'active', 300);

    const rows = new Map(store.session('session-effort').map((row) => [row.eventKey, row]));
    assert.equal(rows.get('response-with-effort').effort, 'high');
    assert.equal(rows.get('response-without-effort').effort, null);
  } finally {
    await closeTemporaryStore(directory, store);
  }
});

test('TelemetryStore carries effort from a sessionless turn_context to its usage event', async () => {
  const { directory, store } = await temporaryStore();
  try {
    store.ingest(record('turn_context', {
      turn_id: 'turn-sessionless',
      model: 'gpt-5.6-sol',
      effort: 'high'
    }), '/active/sessionless-effort.jsonl', 'active', 0);
    store.ingest(usageRecord({
      sessionId: 'session-sessionless',
      turnId: 'turn-sessionless',
      responseId: 'response-sessionless',
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13
    }), '/active/sessionless-effort.jsonl', 'active', 100);

    const row = store.session('session-sessionless')[0];
    assert.equal(row.effort, 'high');
  } finally {
    await closeTemporaryStore(directory, store);
  }
});

test('TelemetryStore migrates an existing usage_events table without effort', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-effort-migration-'));
  const databasePath = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      CREATE TABLE usage_events (
        event_key TEXT PRIMARY KEY,
        response_id TEXT UNIQUE,
        session_id TEXT,
        turn_id TEXT,
        root_turn_id TEXT,
        occurred_at TEXT,
        model TEXT,
        model_resolution TEXT,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_output_tokens INTEGER,
        total_tokens INTEGER,
        cost_input REAL,
        cost_cached REAL,
        cost_output REAL,
        cost_total REAL,
        price_version TEXT,
        source_file TEXT,
        source_offset INTEGER
      );
      INSERT INTO usage_events(
        event_key, response_id, session_id, turn_id, root_turn_id, occurred_at,
        model, model_resolution, input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens, cost_input, cost_cached,
        cost_output, cost_total, price_version, source_file, source_offset
      ) VALUES (
        'legacy-event', 'legacy-response', 'legacy-session', 'legacy-turn', 'legacy-root',
        '2026-09-10T12:00:00.000Z', 'gpt-5.6-sol', 'session_meta', 1, 0, 0,
        1, 0, 2, 0.000004, 0, 0.00002, 0.000024, '2026-09-10-standard', '/legacy.jsonl', 0
      );
    `);
  } finally {
    legacy.close();
  }

  const store = new TelemetryStore(databasePath);
  try {
    const legacyRow = store.session('legacy-session')[0];
    assert.ok(legacyRow);
    assert.equal(legacyRow.effort, null);
    assert.equal(store.ingest(usageRecord({
      sessionId: 'legacy-session',
      turnId: 'legacy-turn-new',
      responseId: 'post-migration-response',
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
      timestamp: '2026-09-10T12:01:00.000Z'
    }), '/legacy.jsonl', 'active', 200), true);
    assert.equal(store.session('legacy-session').find((row) => row.eventKey === 'post-migration-response').effort, null);
  } finally {
    store.close();
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = migrated.prepare('PRAGMA table_info(usage_events)').all().map((column) => column.name);
      assert.equal(columns.includes('effort'), true);
    } finally {
      migrated.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('TelemetryStore migrates legacy usage and remains ready for per-thread source backfill', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-session-source-migration-'));
  const active = path.join(directory, 'active');
  const databasePath = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        first_seen_at TEXT,
        last_seen_at TEXT,
        fallback_model TEXT,
        source_kind TEXT
      );
      CREATE TABLE usage_events (
        event_key TEXT PRIMARY KEY,
        response_id TEXT UNIQUE,
        session_id TEXT,
        turn_id TEXT,
        root_turn_id TEXT,
        occurred_at TEXT,
        model TEXT,
        model_resolution TEXT,
        effort TEXT,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_output_tokens INTEGER,
        total_tokens INTEGER,
        cost_input REAL,
        cost_cached REAL,
        cost_output REAL,
        cost_total REAL,
        price_version TEXT,
        source_file TEXT,
        source_offset INTEGER
      );
      INSERT INTO sessions(session_id, first_seen_at, last_seen_at, fallback_model, source_kind)
      VALUES ('legacy-session-source', '2026-09-10T12:00:00.000Z', '2026-09-10T12:00:00.000Z', 'gpt-5.6-sol', 'active');
      INSERT INTO usage_events(
        event_key, response_id, session_id, turn_id, root_turn_id, occurred_at,
        model, model_resolution, effort, input_tokens, cached_input_tokens,
        cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
        cost_input, cost_cached, cost_output, cost_total, price_version, source_file, source_offset
      ) VALUES (
        'legacy-session-source-event', 'legacy-session-source-response', 'legacy-session-source',
        'legacy-session-source-turn', 'legacy-session-source-root', '2026-09-10T12:00:01.000Z',
        'gpt-5.6-sol', 'session_meta', NULL, 3, 0, 0, 1, 0, 4,
        0.000012, 0, 0.00002, 0.000032, '2026-09-10-standard', '/legacy.jsonl', 0
      );
      PRAGMA user_version = 2;
    `);
  } finally {
    legacy.close();
  }

  await mkdir(active, { recursive: true });
  const store = new TelemetryStore(databasePath);
  try {
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const sessionColumns = migrated.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
      const usageColumns = migrated.prepare('PRAGMA table_info(usage_events)').all().map((column) => column.name);
      assert.equal(sessionColumns.includes('thread_source'), true);
      assert.equal(usageColumns.includes('thread_id'), true);
      assert.ok(migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'`).get());
    } finally {
      migrated.close();
    }

    await writeFile(path.join(active, 'legacy-session-source.jsonl'), [
      record('session_meta', {
        id: 'legacy-thread-source',
        session_id: 'legacy-session-source',
        thread_source: 'subagent'
      }),
      usageRecord({
        sessionId: 'legacy-session-source',
        threadId: 'legacy-thread-source',
        turnId: 'legacy-session-source-turn',
        responseId: 'legacy-session-source-response',
        inputTokens: 3,
        outputTokens: 1,
        totalTokens: 4
      })
    ].join('\n') + '\n', 'utf8');

    assert.equal(await store.backfillSessionSources([{ directory: active, kind: 'active' }]), 2);
    const session = store.sessions().find((entry) => entry.sessionId === 'legacy-session-source');
    assert.equal(session.subagentCalls, 1);
    const event = store.session('legacy-session-source')[0];
    assert.equal(event.threadId, 'legacy-thread-source');
    assert.equal(event.threadSource, 'subagent');
    assert.equal(event.isSubagent, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('TelemetryStore retries per-thread backfill after an incomplete version 4 migration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-incomplete-v4-'));
  const active = path.join(directory, 'active');
  const databasePath = path.join(directory, 'telemetry.sqlite');
  const initialStore = new TelemetryStore(databasePath);
  initialStore.ingest(usageRecord({
    sessionId: 'session-incomplete-v4',
    turnId: 'turn-incomplete-v4',
    responseId: 'response-incomplete-v4'
  }), '/legacy/incomplete-v4.jsonl', 'active', 0);
  initialStore.db.exec('PRAGMA user_version = 4');
  initialStore.close();

  await mkdir(active, { recursive: true });
  await writeFile(path.join(active, 'incomplete-v4.jsonl'), [
    record('session_meta', {
      id: 'thread-incomplete-v4',
      session_id: 'session-incomplete-v4',
      thread_source: 'subagent'
    }),
    usageRecord({
      sessionId: 'session-incomplete-v4',
      threadId: 'thread-incomplete-v4',
      turnId: 'turn-incomplete-v4',
      responseId: 'response-incomplete-v4'
    })
  ].join('\n') + '\n', 'utf8');

  const reopenedStore = new TelemetryStore(databasePath);
  try {
    assert.ok(await reopenedStore.backfillSessionSources([{ directory: active, kind: 'active' }]) > 0);
    const event = reopenedStore.session('session-incomplete-v4')[0];
    assert.equal(event.threadId, 'thread-incomplete-v4');
    assert.equal(event.isSubagent, true);
  } finally {
    reopenedStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('TelemetryStore enriches sessions with only displayTitle from an optional local catalog', async () => {
  const { directory, store } = await temporaryStore();
  const catalogDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-title-catalog-'));
  const catalogPath = path.join(catalogDirectory, 'codex-dev.db');
  const sessionId = 'session-title-catalog';
  try {
    createThreadTitleCatalog(catalogPath, [{
      threadId: sessionId,
      displayTitle: 'Título vindo do catálogo',
      sourceUpdatedAt: '2026-09-10T12:34:56.000Z',
      summary: 'não deve aparecer na API'
    }]);
    store.ingest(usageRecord({
      sessionId,
      turnId: 'turn-title-catalog',
      responseId: 'response-title-catalog',
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16
    }), '/active/title-catalog.jsonl', 'active', 0);

    const row = store.sessions(100, { titleCatalogPath: catalogPath }).find((entry) => entry.sessionId === sessionId);
    assert.ok(row);
    assert.equal(row.sessionId, sessionId);
    assert.equal(row.displayTitle, 'Título vindo do catálogo');
    assert.equal(Object.hasOwn(row, 'display_title'), false);
    assert.equal(Object.hasOwn(row, 'sourceUpdatedAt'), false);
    assert.equal(Object.hasOwn(row, 'summary'), false);
    assert.equal(JSON.stringify(row).includes('não deve aparecer na API'), false);
  } finally {
    await closeTemporaryStore(directory, store);
    await rm(catalogDirectory, { recursive: true, force: true });
  }
});

test('TelemetryStore keeps sessionId as displayTitle when the catalog is absent or unreadable', async () => {
  const { directory, store } = await temporaryStore();
  const catalogDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-title-fallback-'));
  const missingPath = path.join(catalogDirectory, 'missing.db');
  const brokenPath = path.join(catalogDirectory, 'broken.db');
  const missingSessionId = 'session-title-catalog-missing';
  const brokenSessionId = 'session-title-catalog-broken';
  try {
    store.ingest(usageRecord({
      sessionId: missingSessionId,
      turnId: 'turn-title-catalog-missing',
      responseId: 'response-title-catalog-missing'
    }), '/active/title-catalog-missing.jsonl', 'active', 0);
    await writeFile(brokenPath, 'not a SQLite database', 'utf8');
    store.ingest(usageRecord({
      sessionId: brokenSessionId,
      turnId: 'turn-title-catalog-broken',
      responseId: 'response-title-catalog-broken'
    }), '/active/title-catalog-broken.jsonl', 'active', 0);

    const rowsWithoutCatalog = store.sessions(100, { titleCatalogPath: missingPath });
    const missingRow = rowsWithoutCatalog.find((entry) => entry.sessionId === missingSessionId);
    assert.ok(missingRow);
    assert.equal(missingRow.displayTitle, missingSessionId);
    assert.equal(Object.hasOwn(missingRow, 'sourceUpdatedAt'), false);

    const rowsWithBrokenCatalog = store.sessions(100, { titleCatalogPath: brokenPath });
    const brokenRow = rowsWithBrokenCatalog.find((entry) => entry.sessionId === brokenSessionId);
    assert.ok(brokenRow);
    assert.equal(brokenRow.displayTitle, brokenSessionId);
    assert.equal(Object.hasOwn(brokenRow, 'sourceUpdatedAt'), false);
  } finally {
    await closeTemporaryStore(directory, store);
    await rm(catalogDirectory, { recursive: true, force: true });
  }
});

test('TelemetryStore ignores cumulative token records and deduplicates active/archive responses', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const activeFile = '/active/session.jsonl';
    const archivedFile = '/archived/session.jsonl';
    const response = usageRecord({
      sessionId: 'session-dedup',
      turnId: 'turn-dedup',
      responseId: 'response-shared',
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 50,
      totalTokens: 150
    });

    assert.equal(store.ingest(response, activeFile, 'active', 10), true);
    assert.equal(store.ingest(response, archivedFile, 'archived', 20), false);
    assert.equal(store.ingest(record('turn_token_usage', {
      session_id: 'session-dedup',
      turn_id: 'turn-dedup',
      usage: { input_tokens: 1000, output_tokens: 1000 }
    }), activeFile, 'active', 30), false);
    assert.equal(store.ingest(record('thread_token_usage', {
      session_id: 'session-dedup',
      usage: { input_tokens: 2000, output_tokens: 2000 }
    }), activeFile, 'active', 40), false);

    const overview = store.overview();
    assert.equal(overview.calls, 1);
    assert.equal(overview.inputTokens, 100);
    assert.equal(overview.cachedInputTokens, 25);
    assert.equal(overview.outputTokens, 50);
    assert.equal(store.session('session-dedup').length, 1);
  } finally {
    await closeTemporaryStore(directory, store);
  }
});

test('TelemetryWatcher resumes after a partial line and handles truncation/rotation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-watcher-'));
  const storeDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-store-'));
  const file = path.join(directory, 'nested', 'session.jsonl');
  const store = new TelemetryStore(path.join(storeDirectory, 'telemetry.sqlite'));
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const first = usageRecord({
      sessionId: 'session-watcher',
      turnId: 'turn-watcher',
      responseId: 'response-complete',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      extraPayload: { harmless_metadata: 'x'.repeat(128) }
    });
    const partial = usageRecord({
      sessionId: 'session-watcher',
      turnId: 'turn-watcher',
      responseId: 'response-partial',
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 28
    });
    await writeFile(file, `${first}\n${partial.slice(0, -8)}`, 'utf8');

    const watcher = new TelemetryWatcher(store, [{ directory, kind: 'active' }]);
    assert.equal(await watcher.scan(), 1);
    assert.equal(store.overview().calls, 1);

    await appendFile(file, `${partial.slice(-8)}\n`, 'utf8');
    assert.equal(await watcher.scan(), 1);
    assert.equal(store.overview().calls, 2);

    const rotated = usageRecord({
      sessionId: 'session-watcher',
      turnId: 'turn-watcher',
      responseId: 'response-after-rotation',
      inputTokens: 30,
      outputTokens: 9,
      totalTokens: 39
    });
    await writeFile(file, `${rotated}\n`, 'utf8');
    assert.equal(await watcher.scan(), 1);
    assert.equal(store.overview().calls, 3);
    assert.equal(store.session('session-watcher').length, 3);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(storeDirectory, { recursive: true, force: true });
  }
});

test('TelemetryWatcher ingests a complete JSONL record larger than one MiB and advances to EOF', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-large-line-'));
  const storeDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-large-line-store-'));
  const file = path.join(directory, 'large-record.jsonl');
  const store = new TelemetryStore(path.join(storeDirectory, 'telemetry.sqlite'));
  try {
    const line = usageRecord({
      sessionId: 'session-large-line',
      turnId: 'turn-large-line',
      responseId: 'response-large-line',
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
      extraPayload: { harmless_metadata: 'x'.repeat(1024 * 1024) }
    });
    const document = `${line}\n`;
    const documentBytes = Buffer.byteLength(document);
    assert.ok(documentBytes > 1024 * 1024);
    await writeFile(file, document, 'utf8');

    const watcher = new TelemetryWatcher(store, [{ directory, kind: 'active' }]);
    assert.equal(await watcher.scan(), 1);
    const overview = store.overview();
    assert.equal(overview.calls, 1);
    assert.equal(overview.sessions, 1);
    assert.equal(overview.inputTokens, 123);
    assert.equal(overview.cachedInputTokens, 0);
    assert.equal(overview.outputTokens, 45);
    assert.equal(overview.lastEventAt, '2026-09-10T12:00:00.000Z');
    assert.equal(store.session('session-large-line')[0].inputTokens, 123);
    assert.equal(store.session('session-large-line')[0].outputTokens, 45);
    assert.equal(store.cursor(file), documentBytes);
    assert.equal(await watcher.scan(), 0);
    assert.equal(store.cursor(file), documentBytes);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(storeDirectory, { recursive: true, force: true });
  }
});

test('TelemetryWatcher deduplicates a response present in active and archived fixtures', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-fixtures-'));
  const active = path.join(directory, 'active');
  const archived = path.join(directory, 'archived');
  const storeDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-telemetry-store-'));
  const store = new TelemetryStore(path.join(storeDirectory, 'telemetry.sqlite'));
  try {
    await mkdir(active, { recursive: true });
    await mkdir(archived, { recursive: true });
    await copyFile(path.join(fixtureDirectory, 'fixtures', 'active-session.jsonl'), path.join(active, 'session.jsonl'));
    await copyFile(path.join(fixtureDirectory, 'fixtures', 'archived-session.jsonl'), path.join(archived, 'session.jsonl'));

    const watcher = new TelemetryWatcher(store, [
      { directory: active, kind: 'active' },
      { directory: archived, kind: 'archived' }
    ]);
    assert.ok((await watcher.scan()) > 0);
    assert.equal(store.overview().calls, 2);
    assert.equal(store.session('session-fixture').length, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(storeDirectory, { recursive: true, force: true });
  }
});

test('estimateCost distinguishes cached input and unknown models', () => {
  const cost = estimateCost({ inputTokens: 100_000, cachedInputTokens: 25_000, outputTokens: 10_000 }, 'gpt-5.6-luna');
  assert.equal(cost.priceVersion, '2026-09-standard');
  assert.equal(cost.input, 0.015);
  assert.equal(cost.cached, 0.0005);
  assert.equal(cost.output, 0.012);
  assert.equal(cost.total, 0.0275);

  assert.deepEqual(estimateCost({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, 'unknown-model'), {
    input: null,
    cached: null,
    output: null,
    total: null,
    priceVersion: null
  });
});

test('fixture files contain no conversation text fields', async () => {
  const fixtureFiles = ['active-session.jsonl', 'archived-session.jsonl'];
  for (const fixtureFile of fixtureFiles) {
    const content = await readFile(path.join(fixtureDirectory, 'fixtures', fixtureFile), 'utf8');
    assert.equal(content.includes('prompt text'), false);
    assert.equal(content.includes('tool result'), false);
  }
});

test('server remains a clean process when SIGINT is delivered twice during SSE shutdown', async () => {
  const result = await duplicateSigintResult();
  assert.equal(result.code, 0, `server shutdown failed (${result.signal})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /database is not open/i, `duplicate close reached SQLite:\n${result.stderr}`);
});

test('frontend formats updated header, trace timestamps, and token counts with K suffixes', async () => {
  const source = await readFile(path.join(projectDirectory, 'public', 'app.js'), 'utf8');
  const nodes = new Map();
  const createNode = (tagName) => {
    const node = {
      tagName,
      children: [],
      className: '',
      onclick: null,
      _textContent: '',
      _innerHTML: '',
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      set textContent(value) { this._textContent = String(value); },
      get textContent() { return this._textContent; },
      set innerHTML(value) { this._innerHTML = String(value); },
      get innerHTML() { return this._innerHTML; }
    };
    return node;
  };
  const document = {
    createElement: createNode,
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, createNode('div'));
      return nodes.get(id);
    }
  };
  const timestamp = new Date(2026, 8, 10, 9, 5, 6).toISOString();
  const payloads = {
    '/api/overview': { sessions: 1, calls: 1, inputTokens: 12_500, uncachedInputTokens: 11_300, cachedInputTokens: 1_200, outputTokens: 9_999, costTotal: 0, lastEventAt: timestamp },
    '/api/sessions': [{ sessionId: 'session-ui', displayTitle: 'UI test', model: 'gpt-5.6-luna', calls: 1, costTotal: 0 }],
    '/api/sessions/session-ui': [{ occurredAt: timestamp, model: 'gpt-5.6-luna', isSubagent: false, effort: 'low', inputTokens: 12_500, uncachedInputTokens: 11_300, cachedInputTokens: 1_200, outputTokens: 9_999, reasoningOutputTokens: 800, costTotal: 0, costInput: 0, costCached: 0, costOutput: 0 }]
  };
  const context = vm.createContext({
    document,
    fetch: async (url) => ({ json: async () => payloads[url] }),
    EventSource: class { addEventListener() {} },
    Intl,
    console
  });

  vm.runInContext(source, context, { filename: 'public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const compactTimestamp = '10/09/26 09:05:06';
  assert.equal(nodes.get('updated').textContent, `atualizado ${compactTimestamp}`);
  assert.equal(nodes.get('input').textContent, '12,5K');
  assert.equal(nodes.get('uncached-input').textContent, '11,3K');
  assert.equal(nodes.get('cache').textContent, '1,2K');
  assert.equal(nodes.get('output').textContent, '10K');
  assert.equal(nodes.get('events').children.length, 1);
  assert.match(nodes.get('events').children[0].innerHTML, /12,5K.*11,3K.*1,2K.*10K.*800/);
  const traceTime = nodes.get('events').children[0].innerHTML.match(/<time>(.*?)<\/time>/);
  assert.equal(traceTime?.[1], compactTimestamp);
});
