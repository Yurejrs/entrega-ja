# Checklist de release 1.0.0-beta.1.1

## Implementado nesta preparação

- A fila GPS drena todos os lotes pendentes, com mutex por rota para evitar chamadas concorrentes.
- O envio GPS repete falhas transitórias com backoff e preserva lotes quando a API não confirma todos os IDs.
- O servidor devolve os `clientPointId` confirmados; o Android só remove pontos depois dessa confirmação.
- API, mobile e configuração Android estão alinhados em `1.0.0-beta.1.1`; o `versionCode` foi incrementado para `24`.
- O APK release não usa a assinatura de debug e falha explicitamente sem uma keystore de produção.
- O manifesto principal desabilita tráfego HTTP em release; o manifesto de debug continua permitindo o ambiente local.
- O smoke test e o roteiro Android apontam para o artefato `v1.0.0-beta.1`.
- O cadastro de entrega pesquisa clientes remotamente e filtra endereços pelo cliente selecionado.
- O dashboard usa um único polling e sinaliza rotas sem sinal ou com GPS atrasado.
- O dashboard exibe o estado do worker de notificações, a idade do heartbeat e a fila pendente; ausência de heartbeat indica worker parado ou sem configuração.
- Quando o Firebase não está configurado, o worker permanece vivo e registra `no_credential`; a Gestão diferencia essa condição de worker parado e mantém o fallback operacional.
- O servidor rejeita pontos GPS futuros/antigos e exclui pontos de baixa precisão do mapa operacional, mantendo-os para auditoria.
- O worker aplica a retenção de fotos de entregas terminais após 180 dias, com remoção do registro e tentativa de remoção do arquivo privado.
- O worker remove eventos de entrega com mais de 365 dias quando não há foto vinculada; dependências de foto são preservadas até a limpeza da foto.
- O relatório somente leitura de candidatos a retenção de clientes e usuários está disponível antes da aprovação de exclusão/anonimização.
- A aplicação manual da retenção de clientes e usuários exige `RETENTION_APPLY_APPROVED=true`, confirmação humana e backup prévio.
- Foram preparados rascunhos de política de privacidade e termos mínimos de uso comercial; ambos aguardam revisão jurídica e publicação.
- O script `scripts/publish-android-release.sh` automatiza build, validação de pacote/assinatura e geração de `releases/SHA256SUMS`; exige `RELEASE_PRODUCTION_APPROVED=true` como confirmação explícita da keystore de produção.
- O início da rota exige aceite versionado da política de localização e o app apresenta esse aceite ao entregador.
- O pipeline de build foi executado com Node 26.13.1, JDK 17.0.21.1 e Android SDK 36 usando uma keystore temporária fora do repositório; o APK gerado passou na assinatura v2 e no manifesto 1.0.0-beta.1/cleartext desabilitado.

## Antes de publicar

- [ ] Configurar `RELEASE_STORE_FILE`, `RELEASE_STORE_PASSWORD`, `RELEASE_KEY_ALIAS` e `RELEASE_KEY_PASSWORD` fora do repositório.
- [ ] Gerar `releases/entrega-ja-android-v1.0.0-beta.1.apk` com Node 26, JDK 17 e Android SDK homologado usando `scripts/publish-android-release.sh`.
- [x] Validar o pipeline de build com uma keystore temporária de verificação; ainda falta repetir com a keystore de produção.
- [ ] Executar `EXPO_PUBLIC_API_URL=https://... RELEASE_STORE_FILE=/caminho/release.jks pnpm --filter @entregas/mobile build:android:release` com os quatro segredos de assinatura definidos no ambiente.
- [ ] Verificar a assinatura com `apksigner` e publicar o SHA-256 em `releases/SHA256SUMS`.
- [ ] Definir `EXPO_PUBLIC_API_URL` com uma URL HTTPS de produção.
- [ ] Em produção, manter `COOKIE_SECURE=true` (o servidor rejeita `false`).
- [ ] Rodar testes web, API e mobile, além do smoke test em aparelho físico.
- [ ] Validar GPS com tela bloqueada, app reiniciado, rede indisponível e encerramento/cancelamento de rota.
- [x] Testar localmente backup/restauração do PostgreSQL junto com `FILE_STORAGE_DIR` (evidência em `docs/backup-restore-test.md`).
- [ ] Repetir o teste de backup/restauração com as credenciais e o armazenamento do ambiente do piloto.
- [ ] Publicar política de retenção/privacidade; o aceite versionado já é exigido pelo app/API e o limite de check-in está definido em 200 m por padrão, aguardando homologação no piloto.
- [ ] Configurar Firebase/worker e validar push com app fechado; enquanto isso, `no_credential` mantém o fallback operacional documentado.

## Handoff externo obrigatório

| Gate | Evidência de aceite | Responsável pelo fornecimento |
| --- | --- | --- |
| Keystore de produção | Caminho/segredos fora do repositório, fingerprint conferido e `releases/SHA256SUMS` gerado pelo publicador | Release/infra |
| API de produção | URL HTTPS, `COOKIE_SECURE=true`, health check e versão OpenAPI `1.0.0-beta.1` | Infra |
| Aparelho Android físico | Registro de teste com tela bloqueada, reinício, rede indisponível, GPS, check-in e conclusão com foto | QA/operação |
| Backup do piloto | Dump PostgreSQL e arquivo privado de fotos restaurados juntos em ambiente temporário, com hashes | Infra/DBA |
| Firebase e worker | Push recebido com app fechado, heartbeat `active` e fila pendente drenada | Infra/operação |
| Privacidade e termos | Revisão jurídica, versão publicada e aceite registrado | Jurídico/controlador |
| Distância de check-in | Valor homologado no piloto e `CHECK_IN_MAX_DISTANCE_M` registrado na configuração | Operação |
