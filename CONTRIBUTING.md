# Como contribuir

Obrigado por considerar uma contribuição.

## Antes de abrir um pull request

1. Crie uma branch a partir de `master`.
2. Mantenha mudanças pequenas e focadas.
3. Não inclua `telemetry.sqlite`, arquivos de sessão do Codex, títulos reais, caminhos pessoais, credenciais ou qualquer conteúdo de conversa.
4. Use fixtures sintéticos e remova identificadores reais de exemplos e capturas de tela.
5. Execute `npm test` e informe o resultado no pull request.

## Princípios do projeto

- Dados e interface devem continuar locais e restritos ao loopback.
- A coleta deve ser mínima: métricas técnicas, não conteúdo de conversas.
- Mudanças no parser precisam preservar deduplicação e cobertura por teste.
- Como o formato de telemetria pode mudar, inclua exemplos sintéticos que cubram o caso novo.

## Issues

Descreva o comportamento observado, versão do Node e versão do Codex quando disponível. Para falhas de segurança, siga [SECURITY.md](SECURITY.md), e não abra uma issue pública.
