# Release oficial 1.0.0

Instalação e recuperação estão descritas em [instalacao.md](instalacao.md) e [backup-restauracao.md](backup-restauracao.md). A release `1.0.0` foi consolidada em 25/11/2026 com commit e tag `v1.0.0`. API, web, mobile, OpenAPI e scripts foram alinhados à versão oficial, e o `versionCode` do projeto passou para `25`. O APK de homologação já instalado (`1.0.0-beta.1.1`, `versionCode 24`) foi mantido, com a URL da API configurável em **Configurações**; nenhum novo APK foi gerado. O registro abaixo conserva as verificações da fase beta e os gates externos que ainda faltam para distribuir o APK assinado.

## Implementado nesta preparação

- A fila GPS drena todos os lotes pendentes, com mutex por rota para evitar chamadas concorrentes.
- O envio GPS repete falhas transitórias com backoff e preserva lotes quando a API não confirma todos os IDs.
- O servidor devolve os `clientPointId` confirmados; o Android só remove pontos depois dessa confirmação.
- API, web, mobile, OpenAPI e scripts estão alinhados em `1.0.0`; a configuração Android usa `versionCode 25`. O build mantido para homologação permanece `1.0.0-beta.1.1`/`24`.
- O APK release não usa a assinatura de debug e falha explicitamente sem uma keystore de produção.
- O manifesto principal desabilita tráfego HTTP em release; o manifesto de debug continua permitindo o ambiente local.
- O smoke test e o roteiro Android apontam para o artefato oficial `v1.0.0`/`25`; o build anterior pode ser validado com `APK_PATH`, `EXPECTED_VERSION` e `EXPECTED_VERSION_CODE`.
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
- O script `scripts/publish-android-release.sh` automatiza build, validação de pacote/assinatura, bloqueio de HTTP sem TLS, conferência da URL HTTPS incorporada e geração de `releases/SHA256SUMS`; exige `RELEASE_PRODUCTION_APPROVED=true` como confirmação explícita da keystore de produção.
- O início da rota exige aceite versionado da política de localização e o app apresenta esse aceite ao entregador.
- Na fase beta, o pipeline de build foi executado com Node 26.13.1, JDK 17.0.21.1 e Android SDK 36 usando uma keystore temporária fora do repositório; o APK gerado passou na assinatura v2 e no manifesto `1.0.0-beta.1.1`/cleartext desabilitado.

## Antes de publicar

- [ ] Configurar `RELEASE_STORE_FILE`, `RELEASE_STORE_PASSWORD`, `RELEASE_KEY_ALIAS` e `RELEASE_KEY_PASSWORD` fora do repositório.
- [x] Alinhar versões de API, web, mobile, OpenAPI e scripts para `1.0.0` com `versionCode 25`.
- [x] Registrar a release com commit e tag `v1.0.0`, mantendo o build anterior para homologação.
- [ ] Gerar `releases/entrega-ja-android-v1.0.0.apk` com Node 26, JDK 17 e Android SDK homologado usando `scripts/publish-android-release.sh`.
- [x] Validar o pipeline de build com uma keystore temporária de verificação; ainda falta repetir com a keystore de produção.
- [ ] Executar `EXPO_PUBLIC_API_URL=https://... RELEASE_STORE_FILE=/caminho/release.jks pnpm --filter @entregas/mobile build:android:release` com os quatro segredos de assinatura definidos no ambiente.
- [ ] Verificar a assinatura com `apksigner` e publicar o SHA-256 em `releases/SHA256SUMS`.
- [ ] Definir `EXPO_PUBLIC_API_URL` com uma URL HTTPS de produção.
- [ ] Em produção, manter `COOKIE_SECURE=true` (o servidor rejeita `false`).
- [x] Rodar testes automatizados web, API e mobile, typechecks e build web (registro abaixo).
- [x] Validar check-in offline no Android: operação persistiu após fechar/reabrir o app e sincronizou uma única vez após reconectar.
- [x] Validar captura da câmera, foto da casa na primeira entrega e conclusão sem pedir foto duplicada no Android físico.
- [x] Corrigir e validar GPS no aparelho: posições recebidas com tela suspensa, fila preservada durante indisponibilidade da API e recuperada ao reconectar, retomada ao reabrir o app e interrupção após registrar saída com rota ainda aberta. Evidências e limites em `docs/teste-android.md`, seção de revalidação do GPS.
- [x] Testar localmente backup/restauração do PostgreSQL junto com `FILE_STORAGE_DIR` (evidência em `docs/backup-restore-test.md`).
- [ ] Repetir o teste de backup/restauração com as credenciais e o armazenamento do ambiente do piloto.
- [ ] Publicar política de retenção/privacidade; o aceite versionado já é exigido pelo app/API e o limite de check-in está definido em 200 m por padrão, aguardando homologação no piloto.
- [ ] Configurar Firebase/worker e validar push com app fechado; enquanto isso, `no_credential` mantém o fallback operacional documentado.

## Handoff externo obrigatório

| Gate | Evidência de aceite | Responsável pelo fornecimento |
| --- | --- | --- |
| Keystore de produção | Caminho/segredos fora do repositório, fingerprint conferido e `releases/SHA256SUMS` gerado pelo publicador | Release/infra |
| API de produção | URL HTTPS, `COOKIE_SECURE=true`, health check e versão OpenAPI `1.0.0` | Infra |
| Aparelho Android físico | Registro de teste com tela bloqueada, reinício, rede indisponível, GPS, check-in e conclusão com foto | QA/operação |
| Backup do piloto | Dump PostgreSQL e arquivo privado de fotos restaurados juntos em ambiente temporário, com hashes | Infra/DBA |
| Firebase e worker | Push recebido com app fechado, heartbeat `active` e fila pendente drenada | Infra/operação |
| Privacidade e termos | Revisão jurídica, versão publicada e aceite registrado | Jurídico/controlador |
| Distância de check-in | Valor homologado no piloto e `CHECK_IN_MAX_DISTANCE_M` registrado na configuração | Operação |

## Execução local em 25/11/2026

- API: 3 testes passaram; typecheck passou. O teste de integração foi executado no PostgreSQL isolado da porta 55433 após aplicar as migrações e papéis locais.
- Banco: `db/manage.sh test` passou nos testes de isolamento e transação.
- Mobile: 32 testes passaram; typecheck passou.
- Gestão web: 5 testes passaram; typecheck incluído no build de produção, que passou.
- APK Android candidato da fase beta: build release passou com keystore temporária de QA e URL HTTPS de teste. O artefato foi verificado como pacote `com.kynesis.entregaja`, versão `1.0.0-beta.1.1`/`versionCode 24`, assinatura v2 válida, `usesCleartextTraffic=false` e permissões de GPS em segundo plano/serviço de localização presentes. SHA-256: `8c668b89f2182f5c5787d02dbf5c0318da857d8ccd815a8ab4ca55fbb360f88f`. Esse build foi mantido para homologação, mas não é o artefato oficial; faltam a keystore e a URL de produção.
- Android físico: com Wi-Fi e dados móveis desligados, o check-in foi salvo localmente; após forçar o fechamento e reabrir o app, a operação continuou pendente. Ao reconectar e sincronizar, a entrega passou a `in_progress` e o banco registrou exatamente um evento `check_in` com `client_operation_id`.
- Permanecem pendentes a captura e sincronização de foto pelo fluxo Android de conclusão e o teste físico de GPS com tela bloqueada. Os testes da API cobrem o recebimento da foto e os endpoints/trilha GPS, mas não substituem essas verificações no dispositivo.

### Complemento Android físico em 25/11/2026

- Rota com duas paradas: seleção, diferenciação visual, progresso 0/2 → 1/2 e avanço à próxima parada passaram no beta instalado.
- Câmera e comprovante: captura registrada na API; entrega concluída sem solicitação de foto adicional quando já existia foto.
- Foto da casa: botão mostrado na primeira entrega, captura persistida e foto reutilizada numa entrega posterior do endereço.
- GPS em segundo plano: reprovado no aparelho testado. Apesar do serviço foreground/notificação ativos, não houve novos pontos de rota ou atualização de presença na API após bloquear a tela por cerca de 30 segundos. Requer correção antes da homologação do acompanhamento.
- A instalação do APK de QA separado foi bloqueada pelo MIUI com `INSTALL_FAILED_USER_RESTRICTED`; os testes funcionais usaram o beta já instalado. O expediente de QA foi encerrado e a rota cancelada.

### Fechamento do item GPS em 25/11/2026

A falha do ensaio anterior foi corrigida e os quatro cenários de GPS foram revalidados no Xiaomi/Android 16. O módulo `expo-location@19.0.8` usa o patch versionado em `patches/`, compilado do código fonte, para despachar posições pelo serviço foreground e manter a CPU ativa por até 30 segundos no processamento de cada lote. O app renova a solicitação na retomada, permite atualizações parado e sincroniza filas pendentes; as requisições da rota têm timeout.

Com o aparelho em `Dozing`, uma captura às 13:28:13 chegou à API no mesmo segundo. Após uma interrupção da conexão com a API, todos os três IDs pendentes de cada fila foram confirmados no banco. Depois de fechar e reabrir, o serviço retomou. Ao registrar saída às 13:32:30, a coleta cessou e os contadores permaneceram estáveis na verificação posterior. O expediente ficou inativo e a configuração normal da API foi restaurada.

O item GPS está aprovado no escopo desse ensaio. A release `1.0.0` está registrada pelo commit e pela tag `v1.0.0`, sem geração de novo APK, por decisão do usuário; a aprovação do GPS não valida o APK assinado de produção. A validação não incluiu reinicialização completa do telefone, deslocamento prolongado nem troca de operadora. Os gates externos acima permanecem responsáveis pela distribuição e pelo piloto.
