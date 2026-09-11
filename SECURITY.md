# Política de segurança

## Escopo

Este projeto lê metadados locais do Codex Desktop e mantém uma base SQLite local. Questões que possam expor telemetria, títulos de sessões, caminhos locais, conteúdo de conversas ou permitir acesso além de `127.0.0.1` estão no escopo.

## Reportar uma vulnerabilidade

Não abra uma issue pública com dados sensíveis ou detalhes exploráveis. Envie uma mensagem privada ao mantenedor do repositório no GitHub com:

- impacto e versão afetada;
- passos mínimos de reprodução, sem arquivos reais de sessão;
- uma sugestão de mitigação, se houver.

Você receberá confirmação de recebimento e uma atualização assim que houver avaliação do caso. Não há SLA formal neste projeto voluntário.

## Boas práticas para quem usa

- Não publique `telemetry.sqlite`, seus arquivos WAL/SHM ou diretórios `~/.codex`.
- Não exponha a porta local por túnel ou proxy reverso.
- Use fixtures sintéticos em issues e pull requests.
