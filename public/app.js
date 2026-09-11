const wholeNumber = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const compactTokens = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const fmt = (tokens) => tokens >= 1000 ? `${compactTokens.format(tokens / 1000)}K` : wholeNumber.format(tokens);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit'
});
const time = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});
const timestamp = (value) => `${date.format(value)} ${time.format(value)}`;
const read = async (url) => { const response = await fetch(url); if (!response.ok) throw new Error(`Falha ao carregar ${url}`); return response.json(); };
const value = (id, text) => document.getElementById(id).textContent = text;
let selected;
let refreshPromise;
let refreshPending = false;
let traceRequest = 0;
const titles = new Map();
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; return node; };
const subagentLabel = (value) => value === true ? 'sim' : value === false ? 'não' : '—';
function sessionButton(session) { const button = document.createElement('button'); const meta = document.createElement('small'); button.className = `session ${selected === session.sessionId ? 'active' : ''}`; button.append(element('strong', '', session.displayTitle), element('span', 'session-id', session.sessionId)); meta.append(element('span', '', `${session.model || 'unknown'} · ${session.calls} chamadas`), element('span', '', usd.format(session.costTotal || 0))); button.append(meta); button.onclick = () => { selected = session.sessionId; void renderSessions(); void renderTrace(); }; return button; }
async function renderSessions() { const sessions = await read('/api/sessions'); const list = document.getElementById('session-list'); sessions.forEach((session) => titles.set(session.sessionId, session.displayTitle)); if (!selected && sessions[0]) selected = sessions[0].sessionId; list.replaceChildren(...sessions.map(sessionButton)); }
function cell(text, className, label) { const node = element('span', className, text); node.setAttribute('role', 'cell'); node.dataset.label = label; return node; }
async function renderTrace() { if (!selected) return; const sessionId = selected; const request = ++traceRequest; try { const rows = await read('/api/sessions/' + encodeURIComponent(sessionId)); if (request !== traceRequest || selected !== sessionId) return; value('trace-title', titles.get(sessionId) || sessionId); value('trace-note', `${sessionId} · ${rows.length} chamadas observadas · modelo resolvido por evidência do turno quando disponível`); value('load-status', ''); const events = document.getElementById('events'); events.replaceChildren(...rows.map(row => { const el = document.createElement('div'); const costs = row.costTotal == null ? '—' : `${usd.format(row.costInput)} / ${usd.format(row.costCached)} / ${usd.format(row.costOutput)}`; const subagentClass = row.isSubagent === true ? 'yes' : row.isSubagent === false ? 'no' : 'unknown'; el.className = 'event'; el.setAttribute('role', 'row'); const timeNode = document.createElement('time'); timeNode.textContent = timestamp(new Date(row.occurredAt)); timeNode.setAttribute('role', 'cell'); el.append(timeNode, cell(row.model || 'unknown', 'model', 'modelo'), cell(subagentLabel(row.isSubagent), `subagent ${subagentClass}`, 'subagente'), cell(row.effort || '—', '', 'effort'), cell(fmt(row.inputTokens), '', 'input'), cell(fmt(row.uncachedInputTokens), '', 'no-cached'), cell(fmt(row.cachedInputTokens), '', 'cache'), cell(fmt(row.outputTokens), '', 'output'), cell(fmt(row.reasoningOutputTokens), '', 'reasoning'), cell(costs, '', 'custo I/C/O')); return el; })); } catch (error) { if (request === traceRequest) value('load-status', 'Não foi possível carregar esta sessão. Tente novamente.'); } }
async function refresh() { if (refreshPromise) { refreshPending = true; return refreshPromise; } refreshPromise = (async () => { try { const data = await read('/api/overview'); value('sessions', data.sessions); value('calls', data.calls); value('input', fmt(data.inputTokens)); value('cache', fmt(data.cachedInputTokens)); value('uncached-input', fmt(data.uncachedInputTokens)); value('output', fmt(data.outputTokens)); value('cost', usd.format(data.costTotal || 0)); value('updated', data.lastEventAt ? `atualizado ${timestamp(new Date(data.lastEventAt))}` : 'aguardando eventos'); await renderSessions(); await renderTrace(); value('load-status', ''); } catch { value('load-status', 'Não foi possível atualizar os dados. Verifique se o servidor local está ativo.'); } finally { refreshPromise = null; if (refreshPending) { refreshPending = false; void refresh(); } } })(); return refreshPromise; }
new EventSource('/events').addEventListener('telemetry', () => { void refresh(); }); void refresh();
