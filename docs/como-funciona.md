# Como funciona (para quem mexe no código)

Este arquivo existe só para explicar as decisões que não se adivinham lendo o
código. Para instalar e usar, veja o [README](../README.md).

## Por que a tela é capturada numa aba separada

Duas restrições do Discord definiram o desenho inteiro:

1. **A atividade roda num iframe de outro domínio.** Nesse contexto o navegador
   nega `getDisplayMedia()` — a função que pede a tela — a menos que o Discord
   marque o iframe com `allow="display-capture"`, o que ele não faz.
2. **WebRTC não existe em atividades.** A documentação do Discord diz que só
   WebSocket é suportado. Sem P2P, sem SFU.

Então a captura acontece **fora** do sandbox, numa aba normal do navegador, e os
quadros vão por WebSocket para o servidor, que os repassa para quem assiste:

```
QUEM MOSTRA                        SERVIDOR              QUEM ASSISTE
aba normal do navegador                                  atividade (iframe)
  getDisplayMedia  ✅                                          │
  VideoEncoder                                                 │
  └──── WebSocket binário ────►  repassa sem                   │
                                 abrir o quadro ───────────────►
                                                          VideoDecoder → canvas
```

Quem assiste nunca sai do Discord. Só quem mostra passa por uma aba.

Se um dia o Discord conceder `display-capture`, o botão **"Testar captura no
iframe"** (no painel de detalhes) passa a funcionar — e aí a aba externa pode
sumir. A atividade já tenta capturar internamente antes de cair para a aba.

## Por que WebCodecs e não MediaRecorder

A primeira versão usava `MediaRecorder` + Media Source Extensions e ficava em
~3 segundos de atraso. O formato de container impõe um piso: o pedaço só sai
depois de fechado, e o player precisa acumular buffer para não engasgar.

WebCodecs elimina os dois. Cada quadro é codificado, enviado e desenhado
individualmente, sem container. E, ao contrário de `display-capture`, WebCodecs
não é bloqueado dentro do iframe.

## Keyframe sob demanda

Quem chega no meio de uma transmissão não consegue decodificar nada até receber
um quadro completo. Em vez de guardar um antigo, o servidor **pede um novo** ao
transmissor quando alguém começa a assistir — a tela aparece em ~1 quadro.

O servidor também barra quadros incompletos para quem ainda não recebeu um
completo: alimentar um decodificador frio com eles só produz erro.

## Assistir é opt-in

O servidor não manda os quadros de uma tela para ninguém que não tenha pedido
explicitamente. É o que segura a banda: filtrar só na exibição gastaria a mesma
saída de rede. Por isso cada tela aparece primeiro como um convite
("Assistir tela") em vez de já começar a tocar.

## Salas

- **No Discord:** não há lista. A atividade entra direto na sala daquela call.
  Com `DISCORD_BOT_TOKEN` configurado, o servidor confirma com o Discord quem
  está no canal de voz; sem ele, o escopo é a instância da atividade.
- **No site:** não existe call para herdar, então a lista de salas é a única
  forma de as pessoas se encontrarem. Salas podem ter senha.

Salas vivem em memória e fecham sozinhas 12 segundos depois de esvaziar — a
carência existe porque recarregar a página desconecta e reconecta.

## Som

O áudio vai pelo mesmo socket e pelo mesmo cabeçalho do vídeo, distinguido só
pelo byte de tipo. Opus a 96 kbps, capturado junto com a tela por
`getDisplayMedia({ audio: { systemAudio: 'include' } })`.

**O som só sai de aba.** Compartilhar a tela inteira entrega a mistura do
sistema, com a saída do Discord dentro — e a call inteira passa a se ouvir de
volta. Não existe API para tirar um processo dessa mistura: o áudio é capturado
por processo e a relação com uma janela não é um-para-um. O que dá para saber é
o `displaySurface` escolhido, e isso basta — `browser` significa som daquela
aba só. Nos outros casos a faixa é parada antes de sair da máquina.

Junto vai `restrictOwnAudio` quando o navegador suporta: ele tira da captura o
que a própria página está tocando, senão quem transmite enquanto assiste devolve
o som da outra tela para a sala, em laço.

Três coisas que o desenho assume:

- **Áudio não tem keyframe.** Cada pacote Opus se decodifica sozinho, então ele
  não passa pelo bloqueio que barra vídeo sem ponto de partida. Se passasse,
  quem entra no meio ficaria mudo até o próximo keyframe.
- **Buraco em áudio é audível.** Um quadro de vídeo perdido não se nota; um
  intervalo sem amostra é um estalo. Por isso a reprodução mantém um colchão de
  80 ms — o som toca um pouco atrás do vivo, e essa folga absorve o solavanco
  da rede. Passando de 320 ms acumulados, corta e volta ao vivo: atraso somado
  não se recupera sozinho.
- **Sincronia é aceitável, não exata.** O vídeo é desenhado assim que chega; o
  som carrega o colchão. A diferença fica em algumas dezenas de milissegundos,
  abaixo do que se percebe em tela de computador. Casar os dois exigiria
  atrasar o vídeo até o áudio — mais latência para resolver um problema que não
  aparece fora de rosto falando.

A reprodução agenda cada pedaço num `AudioBufferSourceNode`, sem AudioWorklet.
O worklet daria precisão por amostra, mas exige um arquivo carregado por URL, e
dentro da atividade toda URL passa pelo proxy do Discord — um caminho a mais
para dar errado, em troca de precisão que pacotes de 20 ms não pedem.

## Protocolo

Cada pacote trafega como binário puro:

```
[1B slot][1B tipo: 1=vídeo completo 2=vídeo parcial 3=som][8B tempo][8B relógio][payload]
```

O `slot` é o número do transmissor, carimbado na origem: o servidor repassa o
buffer sem tocar nele, e quem assiste sabe para qual decodificador mandar. Até
4 transmissores por sala.

O relógio de envio serve só para medir atraso. É exato na mesma máquina; entre
máquinas diferentes, aproximado.

Controle vai em JSON: `start`, `config`, `audio-config`, `stop`, `rtc`
(transmissor → servidor); `state`, `stream-start`, `config`, `audio-config`,
`stream-stop`, `need-keyframe`, `rtc-want`, `rtc`, `rtc-bye`, `chunks`,
`error` (servidor → clientes); `watch`, `unwatch`, `rtc`, `rtc-ativo`
(espectador → servidor).

## WebRTC por cima do relay

O relay acima é o piso, e continua sendo o caminho de todo mundo no primeiro
segundo. Por cima dele, cada espectador ganha uma tentativa de conexão direta
com quem transmite.

A diferença que importa não é o número de saltos — é o transporte. O WebSocket
anda sobre TCP, e TCP não sabe descartar um quadro atrasado: quando a rede
aperta, ele entrega tudo, em ordem, mais tarde. A imagem não fica pior, ela
fica no passado, e o que se vê é a transmissão andando aos saltos. O canal do
WebRTC anda sobre UDP/SCTP e, marcado como não-confiável, deixa o quadro velho
para trás em vez de atrasar tudo. E o que viaja por ele é exatamente o que o
WebCodecs já produziu para o relay: sem fila de jitter de mídia, sem
recodificação, sem um segundo pipeline de vídeo para dar manutenção.

Como funciona a troca:

1. Alguém pede `watch`. O relay começa a entregar na hora, como sempre fez, e
   o servidor manda um `rtc-want` ao transmissor com o nome daquele espectador.
2. O transmissor abre um `RTCPeerConnection`, cria nele um canal de dados
   não-confiável e manda a oferta. O canal nasce antes da oferta porque é ele
   que cria a seção de aplicação no SDP — uma negociação única basta.
3. Offer, answer e candidatos ICE viajam como envelopes opacos pelo mesmo
   socket do relay — ele já existe e já está autenticado.
4. Quando o canal abre, o espectador pede um keyframe pela mesma sinalização.
   O primeiro quadro completo que chegar por lá é que vira a imagem — e não o
   estado "connected" da conexão, que não garante nada. Só então ele avisa
   `rtc-ativo`, e o servidor para de mandar os bytes daquela tela para ele.
5. Se todo mundo que assiste chegou nesse ponto, o servidor manda `chunks:
   false` e o transmissor para de subir quadros pelo relay. Continua
   codificando: os canais diretos bebem dessa mesma saída — o que se economiza
   é a subida, não a produção.

E quando não fecha — NAT simétrico sem TURN, sandbox que bloqueia, rede
corporativa — nada acontece. Passados 8 segundos sem quadro, ou na primeira
falha de ICE, o espectador desiste em silêncio e segue no relay, que nunca foi
desligado para ele. É por isso que o WebCodecs não saiu do código: ele é o que
garante que ninguém fica sem imagem por causa de um roteador.

`TURN_URL`, `TURN_USER` e `TURN_PASS` no `.env` (opcionais) alimentam o
`/api/ice`. Sem eles fica só o STUN público, que resolve a maioria das casas
mas não quem está atrás de CGNAT. Um TURN encaminha o vídeo de verdade — custa
banda, e por isso é escolha de quem hospeda, não padrão.

## Detalhes que não são acidentais

- **`latencyMode: 'realtime'`** no codificador e **`optimizeForLatency: true`**
  no decodificador. Sem eles, ambos acumulam quadros antes de emitir — comprime
  melhor, mas é atraso que nunca mais sai.
- **`frame.close()`** depois de desenhar. `VideoFrame` segura memória de GPU;
  sem isso a aba trava em segundos.
- **Descartar quadro quando a fila do codificador passa de 2.** Fila vira
  atraso permanente. Melhor perder um quadro do que carregar o atraso.
- **`track.contentHint = 'text'`.** Avisa que é tela, não vídeo — mantém texto
  nítido em vez de suavizar bordas.
- **Backpressure no relay.** Se o socket de alguém acumula mais de 2 MB, o
  servidor descarta quadros para essa pessoa em vez de enfileirar. Sem isso, um
  espectador com internet ruim derruba o processo por consumo de memória.
- **Canal direto não-confiável, com backpressure própria.** Fora de ordem e sem
  retransmissão: quadro atrasado não vale a espera que um transporte confiável
  impõe. E quando o `bufferedAmount` do canal passa de 1 MB, o quadro é
  descartado em vez de enfileirado — quem perde o fio recupera no keyframe
  periódico, que sai a cada 3 segundos.
- **A troca de transporte é decidida pelo primeiro keyframe, não pelo
  `connectionState`.** Um peer "connected" que não entrega nada é
  indistinguível de um travamento — e desligar o relay confiando nele deixaria
  a tela preta com a conexão reportando sucesso.
- **`/.proxy/`** em todo fetch e WebSocket feito de dentro da atividade — é
  assim que o Discord roteia para o seu servidor.
- **Client ID vem do servidor, não do build.** Embutir no bundle obrigava a
  rebuildar a cada troca de credencial, e esquecer disso não dava erro: a
  atividade abria e só quebrava no login.

## Estrutura

```
server/
  index.js        HTTP + WebSocket, login do Discord, emissão de tokens
  rooms.js        salas e repasse dos quadros
  tokens.js       tokens assinados (sem biblioteca externa)
  public/share.*  a aba de captura, que roda FORA do Discord
client/
  src/main.js     interface da sala e conexão
  src/player.js   decodifica os quadros e desenha no canvas
  src/audio.js    decodifica o som e agenda a reprodução
shared/
  broadcaster.js  captura + codificação, usada pela aba e pela atividade
  rtc.js          conexão direta por WebRTC, por cima do relay
scripts/
  configurar.mjs  assistente de configuração
  tunel.mjs       sobe o túnel e grava o endereço no .env
  smoke.mjs       teste do servidor ponta a ponta, sem navegador
```

## Testes

```
npm start        # numa janela
npm run smoke    # noutra
```

Cobre autenticação, senha de sala e bloqueio por tentativas, a máquina de
estados do keyframe, "assistir é opt-in", vários transmissores sem misturar os
streams, e isolamento entre salas e instâncias.

## Rodando enquanto mexe no código

`npm start` reconstrói o site a cada execução. Para recarregar sozinho a cada
salvamento, use `npm run dev` — ele sobe o servidor na 3001 e o site na 5173,
e é a 5173 que você abre.
