# Banco de dados de entregas

Primeira versão do banco PostgreSQL para o SaaS multiempresa descrito no documento norteador. As migrações são aplicadas na ordem numérica por uma conta de migração, separada da conta da API.

## Estrutura

- `migrations/0001_initial_schema.sql`: identidade, vínculos empresariais, cadastros, entregas, histórico, fotos, dispositivos, outbox, planos, assinaturas e auditoria.
- `migrations/0002_rls.sql`: papel `app_runtime`, permissões e políticas de isolamento por empresa e entregador.
- `migrations/0003_integrity.sql`: validação do vínculo ativo, regras de atribuição e destinatário da notificação.
- `migrations/0004` a `0015`: sessões, convites, papéis separados, limites contratuais, revogação de sessões e sincronização de reatribuições.
- `migrations/0016` a `0020`: perfil e fotos de usuário, permissões de leitura/gravação para o app e políticas RLS de atualização do próprio perfil.
- `migrations/0021` e `0022`: áreas de operação, catálogo de volumes e entregas disponíveis para aceite pelo primeiro entregador.
- `migrations/0023` a `0026`: rankings sazonais de entregadores, com períodos semanais e mensais.
- `migrations/0027`: rotas com várias paradas, trilha GPS, suporte a oferta livre nas notificações e autorização RLS da retenção.
- `migrations/0028` e `0029`: reconciliação idempotente da política histórica da 0027 e invalidação transacional dos avisos de oferta quando um entregador aceita.
- `migrations/0030`: configuração de gamificação por empresa, medalhas, progresso por entregador, motivos de problema e desafios com bônus, todos protegidos por RLS.
- `migrations/0031`: valor estimado da entrega para métricas e ganhos do entregador.
- `migrations/0032` e `0033`: conclusão de problemas permitida com foto e heartbeat do worker de notificações.
- `migrations/0034`: aceite versionado da política de localização por entregador e empresa.
- `tests/002_fixture.sql` e `tests/003_runtime.sql`: cenários com login real de API, sem privilégios de proprietário.

## Desenvolvimento local

Use `./db/manage.sh up`, `./db/manage.sh migrate`, `./db/manage.sh api-roles` e `./db/manage.sh test`, nessa ordem. O script usa Podman quando disponível e Docker como alternativa, com a imagem PostgreSQL 17. A porta `55432` fica restrita a `127.0.0.1`; o volume nomeado conserva os dados ao executar `./db/manage.sh down`. As credenciais padrão são somente para desenvolvimento local. Para mudar nome do contêiner, banco, porta ou senha, use `ENTREGAS_DB_CONTAINER`, `ENTREGAS_DB_NAME`, `ENTREGAS_DB_PORT` e `ENTREGAS_DB_PASSWORD`.

`migrate` registra nome, SHA-256 e horário em `public.schema_migrations`. Uma migração já aplicada é ignorada; alteração posterior em seu conteúdo causa erro. O SHA-256 anterior conhecido da 0027 é aceito como legado e reconciliado pela 0028 sem reescrever o histórico. Os testes usam o papel de login `app_api_test`, que herda `app_runtime` e não é proprietário nem tem `BYPASSRLS`.

## Aplicação

Para desenvolvimento e testes locais, use `db/manage.sh`, que sobe o PostgreSQL 17, aplica migrações em ordem e registra cada migração com SHA-256 em `public.schema_migrations`. Em um ambiente gerenciado, aplique os mesmos arquivos em ordem com `psql -v ON_ERROR_STOP=1 -f arquivo.sql`. A conta de migração precisa criar a extensão `pgcrypto`, o schema e o papel `app_runtime`. Crie uma conta de login da API e conceda a ela `app_runtime`; essa conta não pode ser superusuária, proprietária das tabelas nem ter `BYPASSRLS`.

Em toda operação autenticada, a API deve abrir uma transação, autenticar o usuário e chamar `app.set_request_context(user_id, membership_id)` usando IDs derivados da sessão autenticada. A função confere vínculo ativo, usuário habilitado e empresa ativa, então define os quatro parâmetros de contexto com escopo local à transação. As políticas RLS conferem novamente essa consistência, inclusive em rotas, paradas e pontos GPS. A API deve usar consultas parametrizadas e encerrar a transação antes de devolver a conexão ao pool. Os IDs não podem vir diretamente do corpo da requisição. A função não substitui autenticação: um cliente com execução arbitrária de SQL ainda poderia tentar apresentar IDs de outra pessoa.

Criação e reatribuição de entrega devem usar uma única transação para alterar `deliveries`, inserir `delivery_events` e inserir uma linha de `notification_outbox` por dispositivo ativo com token FCM. Se qualquer passo falhar, a API deve desfazer a transação inteira. Ao criar uma entrega sem dispositivo registrado, não há destinatário para a outbox; o aplicativo encontra a entrega na próxima sincronização. Os testes cobrem gravação conjunta, reatribuição, destino da notificação e rollback. A API deve continuar validando as transições de estado.

O papel `app_runtime` cobre os fluxos operacionais. Provisionamento de empresas, usuários globais, planos e assinaturas usa uma conta de administração separada e rotinas auditadas da API administrativa. O worker da outbox usa credenciais restritas de banco e valida o destinatário atual antes do envio. As funções de validação da migração `0003` são `SECURITY DEFINER` e pertencem a uma conta de migração privilegiada, não utilizada pela API. A política RLS é uma segunda barreira; a API valida transições de estado, limites dos planos, leitura e gravação de fotos e ações permitidas para cada papel.

## Decisões de modelagem

- `users` guarda a identidade e o e-mail único. `tenant_memberships` guarda cada vínculo e permite somente um ativo por usuário. Vínculos antigos permanecem para preservar atribuições e eventos.
- Chaves estrangeiras compostas por `tenant_id` impedem referências entre empresas, inclusive na atribuição de entregadores.
- `destination_snapshot` conserva o endereço apresentado na entrega, mesmo quando a referência do endereço é corrigida depois.
- `client_operation_id` em `delivery_events` permite rejeitar operações offline repetidas; a API trata replay idempotente e sincronização paginada.
- `storage_key` referencia uma foto privada no servidor. O arquivo e o banco devem ser copiados e restaurados em conjunto.

## Itens antes de um piloto comercial

A regra de check-in por distância e os preços comerciais ainda dependem de decisão do piloto. A política de retenção, exclusão e recuperação está documentada em `docs/privacidade-retencao.md`; a trilha de localização é mantida por 30 dias. A validação real de backup e restauração de banco e fotos ainda deve ser feita no ambiente que receberá o piloto.
