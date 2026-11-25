# Instalação do Entrega Já 1.0.0

Este roteiro prepara a infraestrutura para a versão oficial. A publicação depende dos testes de aceite registrados em [release-1.0.0.md](release-1.0.0.md). Execute os comandos a partir da raiz do repositório.

## Requisitos

Use Linux, Node.js 26, pnpm 11 conforme `packageManager`, PostgreSQL 17, Git e OpenSSL. O ambiente local utiliza Podman ou Docker. Para backup em outro servidor, instale também os clientes PostgreSQL 17, GNU tar e sha256sum.

A aplicação usa quatro conexões distintas para autenticação, operações da empresa, administração da plataforma e worker. Reserve armazenamento persistente para o banco e para `FILE_STORAGE_DIR`.

## Instalação local

```bash
pnpm install --frozen-lockfile
./db/manage.sh up
./db/manage.sh migrate
./db/manage.sh api-roles
cp apps/api/.env.example apps/api/.env
chmod 600 apps/api/.env
openssl rand -hex 32
```

Preencha `MFA_ENCRYPTION_KEY_HEX` no arquivo com o valor gerado. Configure as quatro URLs do banco e um caminho absoluto para `FILE_STORAGE_DIR`. Preserve a chave MFA no cofre de segredos usado para recuperação.

```bash
pnpm --filter @entregas/api build
pnpm --filter @entregas/web build
export BOOTSTRAP_EMAIL='administrador@exemplo.com'
read -rs -p 'Senha inicial: ' BOOTSTRAP_PASSWORD
export BOOTSTRAP_PASSWORD
pnpm --filter @entregas/api bootstrap
unset BOOTSTRAP_PASSWORD
```

Inicie API, web e worker em terminais distintos com `pnpm dev:api`, `pnpm dev:web` e `pnpm --filter @entregas/api worker`. Abra o painel na porta 5173 e conclua o cadastro de MFA no primeiro acesso.

## Instalação em servidor

1. Prepare um banco vazio e uma conta de migração com privilégios para extensões, papéis e funções privilegiadas. Em um servidor com contêiner dedicado, configure `ENTREGAS_DB_CONTAINER`, `ENTREGAS_DB_NAME`, `ENTREGAS_DB_PORT` e `ENTREGAS_DB_PASSWORD` antes de executar `db/manage.sh up` e `migrate`. A porta do banco fica vinculada ao loopback.
2. Para PostgreSQL remoto, execute as migrações ordenadas de `db/migrations` com `psql -X -v ON_ERROR_STOP=1`. Registre nome e SHA-256 em `public.schema_migrations` conforme o procedimento de `db/manage.sh migrate`, incluindo cada registro na mesma transação da respectiva migração.
3. Crie quatro logins exclusivos, com senhas próprias, `NOSUPERUSER NOBYPASSRLS`. Conceda respectivamente `app_auth_runtime`, `app_runtime`, `app_platform_runtime` e `app_worker_runtime`. O comando local `api-roles` utiliza senhas de desenvolvimento. Configure os logins exclusivos nas quatro variáveis `DATABASE_URL_*`.
4. Instale dependências com o lockfile e compile API e web usando os comandos acima. Configure `NODE_ENV=production`, `COOKIE_SECURE=true`, a chave MFA e o diretório privado persistente.
5. Execute API com `node --env-file=/caminho/seguro/api.env apps/api/dist/main.js` e worker com `node --env-file=/caminho/seguro/api.env apps/api/dist/worker.js`. Use um supervisor com reinício automático. Os exemplos em `ops/systemd` contêm caminhos do ambiente local e precisam ser adaptados para o usuário e os diretórios do servidor.
6. Publique `apps/web/dist` por HTTPS. Configure o servidor web para encaminhar `/v1/` à API, preservar cookies e aceitar uploads de fotos de até 8 MB, com margem para multipart. Para atualização ao vivo, mantenha a conexão SSE aberta e desative buffering nesse endpoint. Encaminhe as rotas da interface para `index.html`.
7. Configure Firebase com `FCM_PROJECT_ID` e `GOOGLE_APPLICATION_CREDENTIALS`. Armazene a credencial privada fora do repositório. Configure o cliente Android com `google-services.json` e a URL HTTPS da API.
8. Crie o administrador inicial usando as mesmas variáveis da instalação local e o ambiente de produção carregado. O script bootstrap usa `apps/api/.env`, portanto execute-o com esse arquivo protegido configurado para o banco correto.

## Conferência e atualização

Verifique `/health/live` e `/health/ready`, login com MFA, criação de cliente/endereço, entrega, foto e recebimento de notificações. Confira logs da API e heartbeat do worker.

Antes de atualizar, registre o commit em execução e faça o backup conjunto descrito em [backup-restauracao.md](backup-restauracao.md). Pare API e worker durante alterações do banco. Aplique migrações pendentes, compile o código correspondente e confira a saúde antes de reabrir o acesso.

Para retornar a uma versão anterior com mudanças incompatíveis de banco, restaure banco e arquivos em destinos novos e execute o código associado ao backup. Migrações existentes devem conservar seu conteúdo e checksum.
