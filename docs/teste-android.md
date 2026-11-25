# Homologação do Android — Entrega Já 1.0.0

## Preparação

1. A release `1.0.0` está registrada em `v1.0.0`, mas o APK assinado para distribuição ainda depende da keystore de produção e da URL HTTPS descritas em [release-1.0.0.md](release-1.0.0.md). O build de homologação mantido neste checkout é `1.0.0-beta.1.1`/`versionCode 24`; a URL da API pode ser alterada em **Configurações**. Use `APK_PATH`, `EXPECTED_VERSION` e `EXPECTED_VERSION_CODE` ao validar esse build; os padrões dos scripts apontam para o artefato oficial `1.0.0`/`25`.
2. Conecte o celular à mesma rede do computador. No navegador do celular, abra `http://10.10.0.40:3000/health/ready`; o resultado esperado é `{"status":"ok"}`. Se o IP do computador mudar, abra **Configurações** no app e atualize a URL da API.
3. Entre com a conta de entregador de QA preparada para o teste, abra a aba **Entregas** e deslize a lista para baixo para atualizar.
4. Abra uma entrega da conta de QA preparada para o teste de operações offline. No ambiente local desta homologação, há uma entrega em andamento com check-in sincronizado e duas entregas atribuídas para selecionar uma rota. O endereço de QA tem coordenadas de referência.
5. Confira rua, número, bairro, cidade e UF. A prévia do OpenStreetMap deve mostrar o ponto de entrega cadastrado; toque no mapa para abrir o local em outro aplicativo de mapas.
6. A galeria deve informar que ainda não há fotos nessa nova entrega.

## Check-in offline e reinício

1. Deixe a localização do Android ligada. Desligue Wi-Fi e dados móveis; não desligue a localização.
2. Abra a entrega e toque em **Registrar check-in**. Autorize o acesso à localização se solicitado.
3. Aguarde a tentativa de envio. Confirme o aviso **Salvo no aparelho** e a indicação de operação aguardando envio.
4. Feche completamente o aplicativo e abra novamente, ainda sem internet. A entrega e a operação pendente devem continuar visíveis.
5. Reative a internet e deslize a lista de entregas para baixo para atualizar. A operação pendente deve desaparecer, e a entrega deve passar para **Em rota**.
6. Abra novamente o detalhe: a prévia deve usar a coordenada capturada e indicar **Local registrado no check-in**.
7. Na Gestão Web, confirme um evento **Check-in** no histórico da entrega.

## Rota com GPS em segundo plano

1. Na Gestão Web, deixe ao menos duas entregas abertas atribuídas ao entregador de QA. Sincronize no Android.
2. Em **Entregas → Em aberto**, toque em **Montar rota**. O app mostra instruções; toque nos cartões na ordem desejada. As paradas ficam numeradas e destacadas; toque de novo para remover uma parada. O gesto de manter pressionado também inicia a seleção.
3. O botão **Iniciar rota** informa a quantidade selecionada. Use **Cancelar montagem da rota** para sair sem iniciar.
4. Toque em **Iniciar rota** e conceda localização durante o uso e em segundo plano. O Android deve manter a notificação **Rota em andamento** enquanto a rota estiver ativa.
5. Com a rota em andamento, bloqueie a tela e caminhe alguns minutos. Desbloqueie, volte ao app e sincronize; na Gestão Web, abra uma das entregas da rota e confirme que o acompanhamento mostra a posição/trilha mais recente.
6. Conclua a primeira parada com check-in e foto. A rota deve avançar para a próxima entrega; ao concluir a última, o app deve encerrar o acompanhamento GPS.
7. Para testar fila GPS offline, inicie outra rota, desligue a rede por alguns minutos enquanto se desloca e reconecte. Depois de abrir o app e atualizar a lista, confirme que os pontos armazenados no aparelho aparecem no acompanhamento da rota na Gestão Web.

O GPS em segundo plano foi revalidado no aparelho conforme as evidências ao final deste documento. O push remoto continua fora dessa validação. Para validar notificações com o app fechado, configure `FCM_PROJECT_ID`, a credencial privada do Firebase Admin e mantenha o worker ativo. Com o app aberto, a verificação periódica pode mostrar aviso local.

## Entrega disponível para retirada

1. Na Gestão Web, crie uma entrega e marque **Disponível para quem aceitar primeiro**. Informe os itens e o endereço, sem escolher entregador.
2. No Android com duas contas de entregador, abra **Entregas → Disponíveis**. Confirme que o destino e os itens aparecem, sem telefone do cliente.
3. Toque em **Pegar entrega** em um aparelho. A entrega deve aparecer em **Em aberto**; no outro aparelho, ela deixa de estar disponível. A retirada exige internet.

## Conclusão offline com foto

1. Com a entrega **Em rota**, desligue Wi-Fi e dados móveis novamente.
2. Abra a entrega e toque em **Concluir com foto**. Tire uma foto de teste.
3. Confirme **Salvo no aparelho** e abra **Fotos registradas** ainda offline. A miniatura deve aparecer como aguardando envio; toque nela para conferir a imagem em tela cheia.
4. Feche e reabra o app sem internet. A operação pendente e a miniatura local devem continuar visíveis.
5. Reative a internet e deslize a lista de entregas para baixo para atualizar. A entrega deve passar para **Concluída**.
6. Abra novamente a entrega. A galeria deve mostrar a foto sincronizada pela API; toque nela para abrir a imagem em tela cheia.
7. Na Gestão Web, confirme o evento de conclusão e a foto no detalhe da entrega.

## Preparar outro ensaio

Na Gestão Web, importe a área de operação na seção **Endereços** para obter sugestões de ruas e localidades. Em **Volumes**, adicione os ícones prontos de Feira, Botijão de gás e Galão de água 20 L. Abra **Nova entrega**: o formulário aparece em um cartão modal, no qual é possível selecionar volumes e quantidades, escolher um endereço salvo ou cadastrar um novo endereço junto à entrega. Atribua ao entregador de QA ou disponibilize para retirada. Depois de sincronizar, confira os ícones e as quantidades nos cartões e no detalhe Android. A importação de localidades requer internet.

Os testes automatizados cobrem repetição de `clientOperationId`, isolamento entre empresas, conflitos de reatribuição, persistência SQLite após reiniciar o banco local, busca e recuperação de páginas. A validação de câmera, GPS, conectividade offline e aparência no aparelho deve ser feita no Android.

## Resultado físico registrado em 25/11/2026

O check-in offline foi executado com Wi-Fi e dados móveis desligados. O aviso de salvamento local apareceu; após forçar o fechamento e reabrir o app, a operação continuou pendente. Depois da reconexão e sincronização, a entrega passou para **Em rota** e o banco registrou um único evento de check-in. A conclusão com foto passou no complemento abaixo; o GPS com tela bloqueada foi executado, mas reprovou por não enviar posições.

### Complemento da validação física

- Em 25/11/2026, no Xiaomi 23117RA68G com Android 16 e app beta 1.0.0-beta.1.1, a seleção e início de rota com duas paradas foram exibidos com numeração e destaque. Após concluir a primeira, o app mostrou 1 de 2 concluídas e avançou para a parada seguinte.
- A câmera abriu, permitiu capturar e salvou a foto de comprovante; a API registrou uma foto para a entrega. O fluxo de conclusão não pediu uma segunda foto quando já havia comprovante e concluiu a entrega após confirmação.
- Na primeira entrega do endereço de QA, apareceu **Fotografar a casa**. A imagem capturada foi salva e exibida na entrega seguinte do mesmo endereço.
- O teste de localização em segundo plano não passou: após registrar entrada, iniciar rota, deixar o app em segundo plano e bloquear a tela por cerca de 30 segundos, o serviço foreground e sua notificação permaneceram ativos, mas a API não recebeu pontos GPS (zero pontos de rota e sem `last_seen_at` novo no compartilhamento). A rota foi cancelada e o expediente encerrado; não considerar GPS homologado.
- O APK QA com identificador separado não pôde ser instalado devido ao bloqueio de instalação do MIUI (`INSTALL_FAILED_USER_RESTRICTED`). Os fluxos acima foram executados no beta já instalado, sem substituí-lo. A URL da API usada no teste foi restaurada ao valor original do aparelho (`http://10.10.0.40:3000`); a sincronização desse endereço não foi confirmada durante o encerramento.

### Revalidação do GPS em 25/11/2026

O ensaio posterior identificou eventos nativos de localização aguardando uma tarefa do JobScheduler bloqueada por restrição térmica no Xiaomi (`Restricted due to: thermal`). O patch versionado `patches/expo-location@19.0.8.patch` entrega os eventos diretamente ao executor do TaskManager quando o serviço foreground do expediente está vinculado, com uma trava parcial de CPU limitada a 30 segundos durante o processamento. Sem o serviço foreground, permanece o agendamento original. O módulo é compilado do código fonte por `expo.autolinking.android.buildFromSource` no pacote mobile; instalar dependências pelo lockfile aplica o patch.

A retomada registra novamente o pedido nativo após o app voltar ao primeiro plano. O intervalo de distância foi zerado para permitir atualização parado. A fila é reenviada também na retomada/sincronização; o envio da rota agora usa a mesma requisição com timeout das demais operações. O último estágio da tarefa fica em `metadata.locationDiagnostic` no SQLite, sem coordenadas ou credenciais nesse registro de diagnóstico.

- **Tela suspensa:** `dumpsys power` confirmou `Dozing` em amostras sucessivas, sem alteração de `mLastWakeTime`. Uma posição capturada em `2026-11-25T16:28:13.191Z` chegou ao compartilhamento em `16:28:13.471Z` e à rota em `16:28:13.623Z`, sem abrir o app. Os horários UTC correspondem a 13:28 no aparelho.
- **API indisponível e reconexão:** o redirecionamento USB da porta da API foi retirado, mantendo a rede do telefone. Três pontos ficaram em cada fila SQLite. Ao restaurar a conexão, os três `clientPointId` de cada fila foram encontrados no PostgreSQL. Os pontos de `16:28:43.295Z` e `16:29:13.399Z` chegaram em `16:29:43.249Z`; o aparelho só saiu da suspensão posteriormente. Isso valida a recuperação de indisponibilidade da API, não uma troca física de Wi-Fi para dados móveis.
- **Build e regressão:** APK debug com bundle incorporado compilado com o módulo nativo corrigido; typecheck e 32 testes mobile passaram. O APK instalado é de homologação, não o artefato oficial de publicação.
- **Reinício do app:** o processo foi encerrado por `am force-stop` e o app foi aberto novamente. O expediente e a rota persistiram, o serviço foreground voltou a iniciar e novas posições chegaram ao servidor, incluindo `16:31:42.604Z` recebida em `16:31:46.212Z`. O teste valida a retomada ao reabrir o app; não promete execução enquanto o usuário mantém o pacote em estado de parada forçada nem após reiniciar o telefone sem abrir o app.
- **Saída com rota aberta:** a saída foi registrada em `16:32:30.093Z`. O servidor passou a `inactive`; os contadores de compartilhamento e rota ficaram em 246 e 56, respectivamente, antes e após uma espera de 35 segundos. A última captura permaneceu `16:32:12.608Z`, anterior à saída. A tarefa foi desregistrada e a notificação foreground encerrada. A rota existente foi preservada.
- **Encerramento do ensaio:** URL original `http://10.10.0.40:3000` restaurada e sincronizada, redirecionamento USB removido e cópia QA duplicada desinstalada. O aparelho ficou fora do expediente.

Os cenários de tela suspensa, indisponibilidade da API com recuperação, retomada ao reabrir e saída foram aprovados nesse Xiaomi/Android 16 com o APK de homologação. Este ensaio não cobre deslocamento físico prolongado, alternância entre operadoras ou reinicialização completa do Android.
