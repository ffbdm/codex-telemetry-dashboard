# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Node.js puro, servidor HTTP/SSE, SQLite local e HTML/CSS/JavaScript sem dependências externas.

## Users

Pessoa que usa o Codex Desktop localmente e precisa auditar consumo e comportamento de suas próprias sessões.

## Product Purpose

Exibir, em uma interface local, o uso de tokens e custo estimado por chamada, turno e sessão logo após os eventos de telemetria serem gravados.

## Positioning

Um observador local e somente leitura dos JSONLs do Codex: ele calcula métricas auditáveis sem enviar conteúdo de conversas ou telemetria para a rede.

## Operating Context

Roda no Mac do usuário e acompanha `~/.codex/sessions` e `~/.codex/archived_sessions`. A interface fica restrita ao loopback.

## Capabilities and Constraints

- Exibe modelo resolvido por turno, input, cache, output, reasoning e custo estimado.
- Deduplica respostas entre arquivos ativos e arquivados.
- Nunca persiste ou mostra textos de mensagens, comandos, resultados de ferramentas ou credenciais.
- O custo é uma estimativa baseada em tabela local de preços versionada, não uma fatura do plano Codex.

## Evidence on Hand

Os JSONLs locais contêm `turn_context`, `world_state` e `token_usage_record`, incluindo `response_id`, identificadores de sessão/turno e métricas de tokens.

## Product Principles

- Métricas devem ser rastreáveis à telemetria, sem dupla contagem.
- Privacidade local e minimização de dados são requisitos do produto.
- A leitura deve ser imediata: desvios de cache, modelo e tamanho aparecem sem abrir logs brutos.
- A interface explica incertezas em vez de inventar precisão.

