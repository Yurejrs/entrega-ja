# Teste de backup e restauração

O backup precisa preservar o PostgreSQL e o armazenamento privado de fotos como um único conjunto. O script `scripts/backup.sh` gera:

- `database.dump`, no formato custom do `pg_dump`;
- `private-files.tar`, com o conteúdo de `FILE_STORAGE_DIR`;
- `SHA256SUMS`, para conferir os dois artefatos.

## Procedimento

1. Execute `BACKUP_DATABASE_URL=... FILE_STORAGE_DIR=... BACKUP_DIR=... ./scripts/backup.sh` em um ambiente com `pg_dump`, `tar` e `sha256sum` instalados.
2. Execute `sha256sum -c SHA256SUMS` no diretório gerado.
3. Extraia `private-files.tar` em um diretório temporário e compare a quantidade e os hashes dos arquivos com o armazenamento de origem.
4. Restaure `database.dump` em um banco PostgreSQL temporário, sem sobrescrever o banco de produção.
5. Execute as migrações/checagens de integridade e valide que usuários, entregas, eventos e referências às fotos continuam consultáveis.
6. Só depois da conferência substitua o ambiente de recuperação, se necessário.

## Evidência local

Em 22/11/2026, o procedimento foi executado contra o PostgreSQL de teste e um banco temporário. Os dois hashes passaram; 10 arquivos privados foram extraídos; o banco restaurado apresentou 34 migrações, 68 usuários e 114 entregas. Essa evidência valida o procedimento local, mas não substitui a repetição com as credenciais, volume de fotos e infraestrutura do piloto.

## Verificação de 24/11/2026

Os scripts atuais foram executados com os clientes PostgreSQL 17 do contêiner de testes, em um banco de recuperação separado. Os dois hashes passaram, 42 migrações foram restauradas e a permissão SELECT de app_runtime sobre app.deliveries foi preservada. Um arquivo privado sintético foi recuperado e comparado byte a byte com a origem.

O ensaio cobriu dump, permissões e extração. A validação com o acervo real de fotos, credenciais de produção, login/MFA e infraestrutura de destino continua prevista no roteiro de recuperação. Consulte [backup-restauracao.md](backup-restauracao.md).
