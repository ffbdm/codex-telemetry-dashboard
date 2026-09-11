# Codex Telemetry Dashboard

Painel local e somente leitura para telemetria do Codex Desktop.

## Executar

Requer Node.js 22.5 ou superior.

```sh
npm start
```

Abra `http://127.0.0.1:3337`. A aplicação lê somente `~/.codex/sessions` e `~/.codex/archived_sessions`, persiste métricas em `telemetry.sqlite` e nunca serve JSONLs ou conteúdo de conversas.

Na primeira inicialização após esta versão, o painel faz um backfill dos identificadores em `session_meta` e `token_usage_record` para classificar cada chamada pelo seu `thread_id`, sem ler conteúdo de conversa. Depois disso, novos registros são acompanhados pelo monitoramento incremental normal.

## Limitações

Custos são equivalentes de API a partir de uma tabela local de preços. O modelo de uma chamada é resolvido pelo contexto do turno e pode aparecer como `unknown` se a evidência não existir.
