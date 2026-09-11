# Codex Telemetry Dashboard

Painel local e somente leitura para observar consumo de tokens e estimativas de custo de sessões do Codex Desktop.

> Este é um projeto independente da comunidade. Não é afiliado, patrocinado nem oficialmente suportado pela OpenAI.

## Privacidade e segurança

- O servidor aceita conexões somente em `127.0.0.1`; não exponha essa porta por túnel, proxy reverso ou rede local.
- O painel lê `~/.codex/sessions` e `~/.codex/archived_sessions`, mas extrai apenas identificadores, horários, modelo, esforço e contadores de uso.
- Ele não persiste nem exibe mensagens, comandos, resultados de ferramentas, credenciais ou JSONLs brutos.
- As métricas locais ficam em `telemetry.sqlite`, que é ignorado pelo Git. Nunca publique esse arquivo: ele pode conter identificadores, horários, caminhos locais e títulos de sessões.
- O painel consulta opcionalmente o catálogo local do Codex apenas para exibir títulos. Esses títulos também permanecem locais.

## Requisitos

- macOS com Codex Desktop e os arquivos locais de sessão disponíveis.
- Node.js 22.5 ou superior. O projeto usa o módulo nativo `node:sqlite`.

## Instalação e execução

```sh
git clone https://github.com/ffbdm/codex-telemetry-dashboard.git
cd codex-telemetry-dashboard
npm test
npm start
```

Não há dependências npm para instalar. Abra [http://127.0.0.1:3337](http://127.0.0.1:3337).

Na primeira execução após uma atualização de esquema, o painel percorre os eventos `session_meta` e `token_usage_record` para relacionar chamadas a `thread_id`; o conteúdo da conversa não é processado. Depois disso, o monitoramento é incremental.

## Limitações

- Os custos são estimativas equivalentes de API derivadas de uma tabela local, não uma fatura, saldo ou preço oficial do plano Codex.
- A resolução de modelo depende dos metadados disponíveis no evento e pode aparecer como `unknown`.
- O formato dos arquivos de telemetria locais não é uma API pública estável; atualizações do Codex podem exigir ajustes neste projeto.
- O foco atual é macOS e o layout de dados do Codex Desktop.

## Desenvolvimento

```sh
npm test
```

Leia [CONTRIBUTING.md](CONTRIBUTING.md) para colaborar e [SECURITY.md](SECURITY.md) para reportar vulnerabilidades de forma responsável.

## Licença

[MIT](LICENSE).
