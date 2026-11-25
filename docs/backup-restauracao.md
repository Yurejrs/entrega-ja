# Backup e restauração

O conjunto de recuperação contém o banco, as fotos privadas e a configuração protegida. Fotos de fachada ficam no banco. Comprovantes, fotos de perfil e capas utilizam também `FILE_STORAGE_DIR`.

## Preparar a cópia

Use uma conta de backup capaz de ler todas as empresas e ultrapassar RLS, mantida fora das credenciais da aplicação. Os exemplos usam um serviço PostgreSQL configurado em `.pg_service.conf` e senha em `.pgpass`, com permissão 600. A conta de restauração precisa criar os papéis internos e ser proprietária das funções privilegiadas.

Pause API, worker e outros processos que gravem no banco ou nas fotos durante toda a cópia. Essa pausa conserva a correspondência entre os dois arquivos. Faça a cópia antes de atualizações e em uma janela periódica definida pela operação.

```bash
export BACKUP_DATABASE_URL='service=entregaja_backup'
export FILE_STORAGE_DIR='/srv/entregaja/private-files'
export BACKUP_DIR='/srv/backups/entregaja'
./scripts/backup.sh
```

O script gera `database.dump`, `private-files.tar` e `SHA256SUMS` em uma pasta exclusiva. Uma execução interrompida deixa a pasta com sufixo `.partial`. Confira o código de saída antes de copiar o resultado para o destino externo. Reinicie os serviços ao terminar a tentativa, incluindo em caso de erro.

Registre junto à cópia o commit do código, horário, versão do PostgreSQL e ambiente. Preserve separadamente, em armazenamento protegido, a configuração da API, a chave MFA original, as credenciais Firebase, as senhas dos logins PostgreSQL e a keystore Android. O script conserva as permissões dos objetos do banco. Os logins e suas senhas devem ser provisionados no destino.

Mantenha uma cópia fora do servidor e proteja o transporte e o armazenamento. Defina prazo de retenção e frequência conforme a quantidade de dados que a operação aceita perder. A automação deve registrar falhas e repetir o teste de recuperação regularmente.

## Restaurar em destino novo

Use um banco vazio e uma pasta vazia. Trabalhe com uma cópia confiável do backup e clientes PostgreSQL 17. O restaurador verifica hashes, cria os quatro papéis internos quando necessário e restaura o banco em uma transação.

```bash
export RESTORE_DATABASE_URL='service=entregaja_recuperacao'
export RESTORE_FILE_STORAGE_DIR='/srv/entregaja-recuperacao/private-files'
./scripts/restore.sh '/srv/backups/entregaja/entregaja-DATA-IDENTIFICADOR'
```

Se a extração de fotos falhar depois da restauração do banco, mantenha os serviços parados e conclua a extração em uma pasta vazia. Uma nova execução completa exige outro banco vazio. O script recusa bancos e pastas já preenchidos.

Provisione os quatro logins e seus vínculos conforme [instalacao.md](instalacao.md). Ajuste URLs do banco e `FILE_STORAGE_DIR`, restaure a mesma chave MFA e execute a revisão do código correspondente ao backup. Confira a propriedade das funções `SECURITY DEFINER` e os privilégios dos papéis.

Compare contagens de clientes, entregas, eventos e fotos com a origem. Confira leitura das imagens, login/MFA e isolamento entre empresas usando as credenciais reais da aplicação. Execute `ANALYZE` no banco restaurado. Só direcione o acesso dos usuários após essas verificações.

O dump reflete o instante da cópia. Operações posteriores precisam ser conciliadas a partir do ambiente anterior e das filas dos aparelhos. Guarde o ambiente anterior até concluir a conferência.
