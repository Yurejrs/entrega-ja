# Homologação do Android — Entrega Já 1.0.0-beta.1

## Preparação

1. Instale o APK release `releases/entrega-ja-android-v1.0.0-beta.1.apk` por cima da versão anterior. O arquivo precisa estar assinado com a keystore de produção; builds de debug não atendem ao aceite da release.
2. Conecte o celular à mesma rede do computador. No navegador do celular, abra `http://10.10.0.40:3000/health/ready`; o resultado esperado é `{"status":"ok"}`. Se o IP do computador mudar, abra **Configurações** no app e atualize a URL da API.
3. Entre com a conta de entregador de QA preparada para o teste, abra a aba **Entregas** e deslize a lista para baixo para atualizar.
4. Abra a entrega de QA preparada para o teste de operações offline. Ela usa o endereço de demonstração, com referência geográfica configurada.
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
2. No APK v1.0.0-beta.1, em **Entregas → Em aberto**, toque em **Montar rota**. O app mostra instruções; toque nos cartões na ordem desejada. As paradas ficam numeradas e destacadas; toque de novo para remover uma parada. O gesto de manter pressionado também inicia a seleção.
3. O botão **Iniciar rota** informa a quantidade selecionada. Use **Cancelar montagem da rota** para sair sem iniciar.
4. Toque em **Iniciar rota** e conceda localização durante o uso e em segundo plano. O Android deve manter a notificação **Rota em andamento** enquanto a rota estiver ativa.
5. Com a rota em andamento, bloqueie a tela e caminhe alguns minutos. Desbloqueie, volte ao app e sincronize; na Gestão Web, abra uma das entregas da rota e confirme que o acompanhamento mostra a posição/trilha mais recente.
6. Conclua a primeira parada com check-in e foto. A rota deve avançar para a próxima entrega; ao concluir a última, o app deve encerrar o acompanhamento GPS.
7. Para testar fila GPS offline, inicie outra rota, desligue a rede por alguns minutos enquanto se desloca e reconecte. Depois de abrir o app e atualizar a lista, confirme que os pontos armazenados no aparelho aparecem no acompanhamento da rota na Gestão Web.

O GPS em segundo plano e o push remoto ainda precisam de validação em aparelho físico. Para validar notificações com o app fechado, configure `FCM_PROJECT_ID`, a credencial privada do Firebase Admin e mantenha o worker ativo. Com o app aberto, a verificação periódica pode mostrar aviso local.

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
