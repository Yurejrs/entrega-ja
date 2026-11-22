# API de gestão de entregas

Monólito modular em Node.js 26, TypeScript e Fastify. Atende o painel da empresa, o aplicativo Android e o painel administrativo SaaS por `/v1`. O contrato OpenAPI é servido em `/docs` e `/docs/json`. As migrações PostgreSQL ficam em `db/migrations`.

## Desenvolvimento local

1. Instale Node.js 26 e pnpm 11.
2. Execute `pnpm install` na raiz.
3. Execute `./db/manage.sh up`, `./db/manage.sh migrate` e `./db/manage.sh api-roles`. O banco local usa PostgreSQL 17 e a porta `127.0.0.1:55432`.
4. Copie `apps/api/.env.example` para `apps/api/.env`. Gere `MFA_ENCRYPTION_KEY_HEX` com `openssl rand -hex 32`. As credenciais do exemplo são apenas para o banco local.
5. Crie o primeiro superadministrador uma vez: exporte `BOOTSTRAP_EMAIL` e `BOOTSTRAP_PASSWORD` (mínimo de 8 caracteres), então execute `pnpm --filter @entregas/api bootstrap`. O primeiro login exigirá cadastro de TOTP.
6. Execute `pnpm dev:api`. A API atende `http://127.0.0.1:3000` e expõe `/health/live` e `/health/ready`.

Use `pnpm --filter @entregas/api worker` em outro processo para enviar notificações. O worker requer `FCM_PROJECT_ID` e credenciais do Firebase Admin SDK via `GOOGLE_APPLICATION_CREDENTIALS` ou identidade de serviço. As fotos são privadas em `FILE_STORAGE_DIR`; monte esse diretório em volume persistente e inclua-o no backup junto com o banco.

Para habilitar push no Android, configure no Firebase o aplicativo com o identificador `com.kynesis.entregaja`, salve o arquivo de configuração do cliente como `apps/mobile/google-services.json` e configure as credenciais privadas do Firebase Admin em `GOOGLE_APPLICATION_CREDENTIALS`, além de `FCM_PROJECT_ID` em `apps/api/.env`. O arquivo de credenciais Admin não deve entrar no repositório. Depois gere um novo APK com `pnpm --filter @entregas/mobile build:android:release`; o script executa o prebuild do Expo para incorporar a configuração FCM ao projeto nativo antes do Gradle.

### Ambiente local de teste no aparelho

Os arquivos em `ops/systemd` mantêm PostgreSQL, API e Gestão Web ativos no usuário `yure`. Eles estão habilitados no `systemd --user` com `linger` para reiniciar após a sessão terminar. Consulte `systemctl --user status entregaja-db entregaja-api entregaja-web`; a API deve responder em `http://10.10.0.40:3000/health/ready` e o painel em `http://10.10.0.40:5173/`. O endereço IP é da rede local e pode mudar. As credenciais de demonstração ficam em `apps/api/.env.demo`, com permissão 600, e não devem ser publicadas.

## Testes

O teste de integração usa um banco separado:

```bash
ENTREGAS_DB_CONTAINER=entregas-api-test ENTREGAS_DB_NAME=entregas_api_test ENTREGAS_DB_PORT=55433 ./db/manage.sh up
ENTREGAS_DB_CONTAINER=entregas-api-test ENTREGAS_DB_NAME=entregas_api_test ENTREGAS_DB_PORT=55433 ./db/manage.sh migrate
ENTREGAS_DB_CONTAINER=entregas-api-test ENTREGAS_DB_NAME=entregas_api_test ENTREGAS_DB_PORT=55433 ./db/manage.sh api-roles
pnpm test
```

`pnpm typecheck` e `pnpm build` verificam a compilação. O teste HTTP cobre MFA, convites, permissões, RLS, rotas GPS, ofertas disponíveis para vários entregadores, aceitação concorrente, invalidação dos avisos pendentes, retenção da trilha, entrega, foto, sincronização repetida, suspensão da assinatura e recuperação do worker. Não envia mensagens reais ao FCM: o emissor é substituído no teste.

## Contrato operacional

- O backend autentica a sessão antes de chamar `app.set_request_context` dentro de cada transação operacional. IDs de empresa, usuário e vínculo nunca são aceitos do corpo da requisição como autoridade.
- O superadministrador usa credencial de banco distinta e consulta somente cadastro comercial e métricas agregadas. Ele não recebe acesso às tabelas de clientes, entregas ou fotos.
- Criação e reatribuição de entrega gravam estado, evento e notificações na mesma transação. Uma falha desfaz todos os registros.
- O app envia `clientOperationId` UUID em check-in, problema e conclusão. A repetição com os mesmos dados retorna o evento anterior; a mesma chave com dados diferentes retorna conflito.
- `GET /v1/mobile/sync` devolve entregas atribuídas e `removedDeliveryIds` para limpar o cache após reatribuição. O app deve paginar entregas e remoções com `cursor` e `removalCursor`, manter o mesmo `until` em todas as páginas e só então salvar `serverTime` como próximo `since`.
- A sincronização móvel inclui as coordenadas do check-in mais recente feito pelo entregador atualmente atribuído. O app mostra esse ponto separado das coordenadas de referência do endereço.
- O entregador inicia uma rota com várias entregas atribuídas. O Android mantém o GPS em segundo plano enquanto a rota está ativa, guarda pontos sem rede em SQLite e os envia em lotes idempotentes ao reconectar. A Gestão Web consulta a posição, trilha e próximas paradas; ao concluir cada entrega, a API avança a parada na mesma transação. O histórico de localização é retido por 30 dias.
- Conclusão requer check-in do entregador atual e foto válida. A API decodifica, reduz e armazena a imagem em área privada. O arquivo é movido de uma área temporária antes da transação ser concluída; falhas removem o arquivo e o worker limpa órfãos após 24 horas.
- O worker processa a outbox com `FOR UPDATE SKIP LOCKED`, recupera trabalhos interrompidos após 10 minutos e consulta a atribuição atual antes de enviar. O aplicativo deve sempre buscar os dados atualizados pela API ao receber o alerta.

Os links de convite e recuperação são retornados ao administrador para entrega por um canal externo; a API não envia e-mail. Cobrança permanece manual. A regra de distância do check-in ainda será definida antes do piloto comercial; o histórico de localização da rota expira após 30 dias.

## Clientes em desenvolvimento

A Gestão Web fica em `apps/web` e o aplicativo Android em `apps/mobile`. Execute a API e `pnpm dev:web` para abrir o painel local. Execute `pnpm dev:mobile` para iniciar o Expo. O emulador Android acessa a API em `http://10.0.2.2:3000`; para aparelho físico, configure `extra.apiUrl` em `apps/mobile/app.json` com o IP da máquina na rede. Ambos usam as cores e a tipografia da pasta `Identidade`.

A Gestão Web oferece autenticação, MFA, convites e operações de empresa e SaaS. O painel acompanha entregas por status e por dia, semana ou mês; a lista tem abas de entregas em aberto e finalizadas, com atrasadas incluídas no dia selecionado. Em Endereços, a empresa pode importar ruas e localidades próximas do OpenStreetMap. A seção Volumes mantém um catálogo com ícone e nome, com opções prontas para feira, gás e água; o formulário de nova entrega abre em um cartão modal e permite anexar volumes e quantidades, escolher endereço salvo ou cadastrar outro na mesma operação. Entregas também podem ficar disponíveis para o primeiro entregador que as aceitar; a confirmação é transacional na API. O aplicativo mantém cache SQLite e fila local para check-in, problema e conclusão com foto, além do perfil do entregador e do progresso de entregas concluídas. Rotas com várias paradas compartilham localização em segundo plano e mostram posição, trilha e destino na Gestão Web enquanto estiverem ativas. Com o app aberto, o Android verifica novas entregas a cada 30 segundos e mostra um aviso local. Com o app fechado, o envio depende do Firebase Cloud Messaging: exige `google-services.json`, `FCM_PROJECT_ID`, credencial do Firebase Admin SDK e o worker ativo; sem esses dados os alertas remotos não podem ser enviados. A validação em aparelho físico ainda está pendente.

### APK local de teste

O APK atualizado v0.1.21 está em [releases/entrega-ja-android-v0.1.21-teste.apk](releases/entrega-ja-android-v0.1.21-teste.apk) e no [Google Drive](https://drive.google.com/file/d/1_YlVY0_HhWYntJPL_9PnaQT_9Wa_BZUa/view?usp=drivesdk). O arquivo v0.1.20 abaixo permanece como histórico.

O APK interno de teste v0.1.20 está em [releases/entrega-ja-android-v0.1.20-teste.apk](releases/entrega-ja-android-v0.1.20-teste.apk) e no [Google Drive](https://drive.google.com/file/d/1_YlVY0_HhWYntJPL_9PnaQT_9Wa_BZUa/view?usp=drivesdk); os hashes estão em `releases/SHA256SUMS`. Ele inclui navegação Ritmo/Entregas/Perfil/Configurações, fotos, mapa, acompanhamento GPS em segundo plano, seleção explícita de paradas para montar rotas e a configuração cliente do Firebase para `com.kynesis.entregaja`. O push com o app fechado ainda depende da credencial privada do Firebase Admin, de `FCM_PROJECT_ID=entrega-ja-mobile` e do worker ativo; a validação em aparelho físico permanece pendente. O APK foi assinado com a chave de depuração do Gradle e é apenas para testes internos, não é a release 1.0.0. Ele sugere `http://10.10.0.40:3000` na tela de entrada para o teste na rede local; se o IP do computador mudar, use **Configurações** para informar a nova URL. `http://10.0.2.2:3000` serve apenas para o emulador Android. Configure JDK 17 e Android SDK para gerar novos APKs. O APK anterior v0.1.19 permanece no Drive no [link de teste](https://drive.google.com/file/d/1tifxO11mE6tGVekCstGZ00EomQm1BH2z/view?usp=drivesdk), e o v0.1.18 em [seu link de teste](https://drive.google.com/file/d/1jETyudYjBt3DHPM8-i1yuJashIvoGDjr/view?usp=drivesdk).

Com um aparelho Android ou emulador autorizado no ADB, execute `ADB_BIN=/caminho/para/adb ./scripts/smoke-android.sh` para instalar o APK v0.1.20, iniciar o aplicativo e detectar uma falha imediata de abertura. O início, navegação principal e entrada no modo de seleção de rota foram verificados no emulador Android 36; ainda falta validar manualmente em aparelho físico o GPS com tela bloqueada, a sincronização offline, check-in, problema e conclusão com foto. Para notificações com o app fechado, são necessários o arquivo Firebase Android, as credenciais do Firebase Admin SDK e o worker ativo; com o app aberto, a verificação periódica mostra um aviso local.

O roteiro de aceite no aparelho, com resultados esperados para reinício offline, check-in e conclusão com foto, está em `docs/teste-android.md`.
