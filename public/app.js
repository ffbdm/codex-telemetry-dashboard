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
const read = async (url) => (await fetch(url)).json();
const value = (id, text) => document.getElementById(id).textContent = text;
let selected;
const titles = new Map();
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; return node; };
const subagentLabel = (value) => value === true ? 'sim' : value === false ? 'não' : '—';
function sessionButton(session) { const button = document.createElement('button'); const meta = document.createElement('small'); button.className = `session ${selected === session.sessionId ? 'active' : ''}`; button.append(element('strong', '', session.displayTitle), element('span', 'session-id', session.sessionId)); meta.append(element('span', '', `${session.model || 'unknown'} · ${session.calls} chamadas`), element('span', '', usd.format(session.costTotal || 0))); button.append(meta); button.onclick = () => { selected = session.sessionId; renderSessions(); renderTrace(); }; return button; }
async function renderSessions() { const sessions = await read('/api/sessions'); const list = document.getElementById('session-list'); sessions.forEach((session) => titles.set(session.sessionId, session.displayTitle)); if (!selected && sessions[0]) selected = sessions[0].sessionId; list.replaceChildren(...sessions.map(sessionButton)); }
async function renderTrace() { if (!selected) return; const rows = await read('/api/sessions/' + encodeURIComponent(selected)); value('trace-title', titles.get(selected) || selected); value('trace-note', `${selected} · ${rows.length} chamadas observadas · modelo resolvido por evidência do turno quando disponível`); const events = document.getElementById('events'); events.replaceChildren(...rows.map(row => { const el = document.createElement('div'); const costs = row.costTotal == null ? '—' : `${usd.format(row.costInput)} / ${usd.format(row.costCached)} / ${usd.format(row.costOutput)}`; const subagentClass = row.isSubagent === true ? 'yes' : row.isSubagent === false ? 'no' : 'unknown'; el.className = 'event'; el.innerHTML = `<time>${timestamp(new Date(row.occurredAt))}</time><span class="model">${row.model}</span><span class="subagent ${subagentClass}">${subagentLabel(row.isSubagent)}</span><span>${row.effort || '—'}</span><span>${fmt(row.inputTokens)}</span><span>${fmt(row.uncachedInputTokens)}</span><span>${fmt(row.cachedInputTokens)}</span><span>${fmt(row.outputTokens)}</span><span>${fmt(row.reasoningOutputTokens)}</span><span>${costs}</span>`; return el; })); }
async function refresh() { const data = await read('/api/overview'); value('sessions', data.sessions); value('calls', data.calls); value('input', fmt(data.inputTokens)); value('cache', fmt(data.cachedInputTokens)); value('uncached-input', fmt(data.uncachedInputTokens)); value('output', fmt(data.outputTokens)); value('cost', usd.format(data.costTotal || 0)); value('updated', data.lastEventAt ? `atualizado ${timestamp(new Date(data.lastEventAt))}` : 'aguardando eventos'); await renderSessions(); await renderTrace(); }
new EventSource('/events').addEventListener('telemetry', refresh); refresh();
