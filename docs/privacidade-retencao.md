# Privacidade, retenção e recuperação

Esta política é a referência mínima para o piloto da versão 1.0.0. O tenant deve informar o entregador de que a localização é coletada enquanto uma rota estiver ativa e registrar a ciência antes do primeiro acompanhamento.

## Retenção

| Dado | Retenção operacional | Depois do prazo |
| --- | --- | --- |
| Pontos de localização | 30 dias após `captured_at` | Exclusão automática pelo worker; pontos fora da janela não são usados no mapa |
| Fotos de entrega | Durante a entrega e por 180 dias após conclusão/cancelamento | O worker remove o registro e tenta excluir o arquivo privado; o cleanup de órfãos remove arquivos não referenciados em execução posterior |
| Eventos da entrega | 365 dias após o evento | O worker remove eventos antigos sem foto vinculada; eventos com dependência de foto aguardam a retenção da foto |
| Clientes arquivados | 90 dias após `archived_at` | Exclusão definitiva se não houver dependência; caso haja histórico, anonimizar nome, telefone e e-mail mantendo o vínculo operacional mínimo |
| Usuários desligados | 90 dias após `disabled_at` | Revogar sessões/dispositivos e anonimizar dados pessoais; manter identificador técnico nos eventos de auditoria |

Os prazos de clientes e usuários exigem job de retenção com relatório de pré-exclusão e aprovação do responsável pelo tenant. A retenção automática atualmente implementada cobre a trilha GPS, fotos de entregas terminais e eventos sem dependência de foto; os demais dados permanecem preservados até o job aprovado existir.

Antes de aprovar essa etapa, gere o relatório somente leitura com `RETENTION_DATABASE_URL=... ./scripts/retention-report.sh`. O relatório não expõe dados pessoais nem altera o banco; a decisão deve registrar a data, o responsável e o conjunto de tenants revisado.

Após a aprovação registrada, aplique a rotina manual com `RETENTION_APPLY_APPROVED=true RETENTION_DATABASE_URL=... ./scripts/retention-apply.sh`. A rotina é transacional: remove clientes arquivados sem histórico, anonimiza clientes com histórico, revoga sessões/dispositivos e anonimiza usuários desligados. Não execute sem revisar o relatório e confirmar o backup.

## Direitos operacionais

- Exclusão definitiva remove dados pessoais, fotos privadas e dispositivos; registros necessários para auditoria devem ser anonimizados, não reaproveitados para identificação.
- Restauração é feita a partir de um dump PostgreSQL e do arquivo de fotos do mesmo conjunto de backup. Restaurar somente um dos dois é considerado recuperação inválida.
- Solicitações de restauração devem apontar para um backup identificado por data e hash, ser testadas em ambiente temporário e só depois substituir o ambiente de produção.
- O armazenamento de fotos deve permanecer privado, com permissão de leitura apenas para a API e backup autorizado.

## Aceite e comunicação

O piloto deve guardar data, usuário, tenant, versão da política e texto apresentado no aceite de localização. A API agora bloqueia o início da rota sem o aceite versionado; o app apresenta o texto ao entregador antes de criar a rota. A política comercial completa e os termos de uso devem ser publicados antes de usuários reais entrarem no piloto.

## Check-in por distância

O limite padrão é 200 metros (`CHECK_IN_MAX_DISTANCE_M`), podendo ser ajustado entre 1 e 5.000 metros antes do piloto. Quando o endereço não possui coordenadas de referência, o servidor não bloqueia o check-in por distância e a operação deve ser auditada como “sem coordenada”. GPS impreciso não amplia o limite: o entregador deve melhorar a precisão e tentar novamente.

## Qualidade temporal e precisão do GPS

Pontos com `capturedAt` até 5 minutos no futuro são rejeitados, assim como pontos com mais de 30 dias. O primeiro limite tolera pequenas diferenças de relógio; o segundo coincide com a retenção da trilha. Pontos com precisão acima de 200 m são aceitos e mantidos para auditoria, mas não entram na posição operacional nem na trilha exibida; a resposta de sincronização informa quantos foram classificados como baixa precisão. Os limites podem ser ajustados por `GPS_MAX_FUTURE_SKEW_SECONDS`, `GPS_MAX_AGE_DAYS` e `GPS_LOW_PRECISION_THRESHOLD_M`.

## Recuperação antes do piloto

1. Execute `BACKUP_DATABASE_URL=... FILE_STORAGE_DIR=... BACKUP_DIR=... ./scripts/backup.sh`.
2. Calcule e preserve os hashes gerados junto ao backup.
3. Restaure o dump em um PostgreSQL temporário e extraia as fotos em um diretório temporário.
4. Confirme contagens de tenants, entregas, eventos, fotos e bytes; compare os hashes dos arquivos.
5. Registre data, duração, resultado e divergências. O teste só passa quando banco e fotos forem recuperados conjuntamente.
