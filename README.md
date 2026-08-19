![Como não compartilhar tela no Discord](como-nao-compartilhar-tela-no-discord-banner.png)

# Sala de Tela

Mostre sua tela para quem está na mesma call do Discord.
Uma pessoa compartilha, todo mundo assiste sem sair do Discord.

Também funciona como site normal, fora do Discord, com salas que você cria e
compartilha por link.

---

## O que você precisa antes

**1. Node.js** — é o programa que faz tudo isso rodar.

Baixe em [nodejs.org](https://nodejs.org), escolha a versão **LTS** e instale
clicando em avançar até o fim. Não precisa configurar nada.

**2. Google Chrome, Edge, Brave ou Opera** — só para quem vai *mostrar* a tela.
Para *assistir*, qualquer navegador serve.

> Não funciona no celular para compartilhar. Celular não deixa nenhum site
> capturar a tela. Assistir pelo celular também costuma falhar.

---

## Ligar tudo (um comando)

### No Windows

Dê dois cliques em **`iniciar.bat`**. Ele:

- usa o Node.js do computador quando houver uma versão compatível;
- caso contrário, baixa uma cópia portátil e verificada para `.cache/`, sem
  instalar nada no Windows;
- roda `npm ci` sempre que abrir, para instalar ou conferir as dependências;
- mostra um resumo seguro do `.env` e deixa usar a configuração atual, mesmo
  vazia ou incompleta, ou abrir novamente o assistente de configuração;
- permite iniciar normalmente ou com `npm run start:fast`.

Tokens e secrets nunca aparecem no resumo. A pergunta sobre usar ou
reconfigurar o `.env` aparece em toda execução.

### Em outros sistemas, ou pelo terminal

**1.** Baixe este projeto e descompacte numa pasta.

**2.** Abra a pasta, clique na barra de endereço do explorador de arquivos,
digite `cmd` e aperte Enter. Vai abrir uma janela preta — é ali que você digita
os comandos.

**3.** Digite, um de cada vez, esperando cada um terminar:

```
npm install
npm run start:fast
```

E pronto. Esse segundo comando faz tudo sozinho: se faltar alguma configuração
ele pergunta na hora, depois monta o site, abre o endereço público e liga o
servidor. **Uma janela só.**

Na primeira vez ele baixa o `cloudflared` (uns 50 MB) e guarda em `.cache/`
dentro da pasta do projeto. Você não instala nada à mão.

Para desligar, aperte `Ctrl + C` na janela preta. Isso derruba tudo junto.

### Só quero testar no navegador

Se ele perguntar como você quer usar, escolha a opção **sem Discord**. Aí é só
abrir <http://localhost:3001> em duas janelas, criar uma sala numa, entrar pela
outra e clicar em **Compartilhar tela** — você vê sua própria tela chegando do
outro lado.

---

## Usar dentro do Discord

O Discord exige que você registre o programa no site dele. É uma vez só.

Quando o `npm run start:fast` pedir, ele vai te dizer exatamente onde achar cada
valor no site do Discord, e no fim mostra **as coisas para colar lá**, já
preenchidas com os seus dados. Faça o que ele mandar.

Depois, no Discord: entre num canal de voz, clique no **foguete** 🚀 na barra de
baixo e escolha a atividade.

Dentro do Discord não existe lista de salas: quem abre a atividade cai direto na
sala daquela call, junto com o resto do pessoal que está lá.

### O endereço que muda toda vez

Por padrão o endereço público é descartável: **ele muda toda vez que você
desliga e liga o programa**. E aí a atividade para de abrir, até você ir no site
do Discord trocar o *Target* pelo endereço novo.

Para acabar com isso de vez, rode **uma única vez**:

```
npm run tunel:criar
```

Ele abre o login da Cloudflare no navegador, cria um endereço fixo, aponta o DNS
e já deixa tudo escrito na configuração. Depois disso o endereço nunca mais
muda, e você não mexe no site do Discord de novo.

> Precisa de um domínio seu já na Cloudflare. Se não tiver, siga com o
> descartável mesmo — só lembre de atualizar o *Target* quando reiniciar.

---

## Painel administrativo

O painel mostra em tempo real pessoas e servidores conectados, salas,
transmissões, banda usada pelo relay, ping, descartes, CPU, memória, disco e
informações do processo/container.

Ative o modo de desenvolvedor no Discord, clique com o botão direito na sua
conta e use **Copiar ID do usuário**. Depois acrescente ao `.env`:

```env
DISCORD_ADMIN_ID=123456789012345678
```

Reinicie o servidor e abra `https://seu-dominio.com/admin`. O painel pede login
pelo Discord e o backend compara a conta confirmada pelo próprio Discord com o
ID acima. Os endpoints não aceitam um ID enviado pelo navegador e não expõem
Client Secret, Bot Token ou Session Secret.

No Linux, o painel também lê `/proc`, cgroups e o sistema de arquivos para
mostrar tráfego de rede do host/container e limites do container. No Windows,
CPU, memória, disco e todas as métricas da aplicação funcionam; apenas os
contadores globais de rede da máquina ficam indisponíveis.

O nome de um servidor é resolvido com o Bot Token. Quando o bot não estiver
naquele servidor, o painel mostra o Guild ID sem impedir as outras métricas.

---

## Compartilhando com som

Ao clicar em **Compartilhar tela**, marque *Compartilhar o som*.

Na janela que o navegador abre, **escolha uma aba** e marque a caixinha de áudio
que aparece lá embaixo.

### Por que só aba?

Se você escolher a tela inteira, o computador entrega **todo** o som que está
tocando — inclusive o do Discord. Aí todo mundo na call escuta a própria voz de
volta, com atraso. É insuportável em segundos.

Nenhum navegador consegue tirar um programa específico dessa captura: o som vem
misturado, é tudo ou nada. Por isso, se você escolher a tela inteira, o programa
transmite **sem som** — e o botão de engrenagem fica amarelo piscando.

### Quero mostrar a tela inteira E ter som

Dá. Clique na engrenagem amarela e escolha **"Som de uma aba"**. O vídeo continua
sendo a tela inteira, e o som passa a vir da aba que você escolher — que é a
única fonte que não carrega o Discord junto.

Serve para YouTube, Twitch, jogo de navegador. Para um jogo instalado, cujo som
não está em aba nenhuma, não tem como — nem aqui nem em qualquer outro site.

Quem assiste passa o mouse no alto-falante da barra de baixo para ajustar o
volume, ou clica nele para silenciar.

> Som funciona no Chrome, Edge, Brave e Opera.

---

## Deu errado?

**A atividade não abre, ou fica só um retângulo branco**
O endereço público mudou. Vá no site do Discord em **Activities → URL Mappings**
e troque o *Target* pelo endereço que aparece na janela preta. Para isso não
acontecer nunca mais, rode `npm run tunel:criar`.

**"A porta 3001 já está sendo usada"**
Tem outra janela do programa aberta. Feche a outra e tente de novo.

**O botão de compartilhar abre uma aba e não acontece nada**
Essa aba precisa continuar aberta enquanto você transmite. Pode voltar para o
Discord normalmente, só não feche a aba.

**"npm não é reconhecido como um comando"**
O Node.js não foi instalado, ou a janela preta foi aberta antes da instalação.
No Windows, use `iniciar.bat`: ele prepara uma cópia portátil automaticamente.
Nos outros sistemas, instale a versão LTS do Node.js, feche o terminal, abra de
novo e tente outra vez.

**Não sai som**
Abra o botão ⓘ na barra de baixo e olhe a linha **Som**. Ela diz em qual dos
casos você está: sem áudio na transmissão, esperando o áudio, silenciado aí, ou
tocando.

**Quero mudar alguma configuração**
Rode `npm run configurar`. Ele lembra do que você já respondeu — é só apertar
Enter no que não mudou.

**A "Sala da call" não confere quem está no canal de voz**
Isso é opcional e só importa se você quer garantir que apenas quem está na call
consiga entrar. Precisa criar um bot no site do Discord e colar o token dele em
`DISCORD_BOT_TOKEN`, dentro do arquivo `.env`. Sem isso tudo funciona igual.

---

## Deixar no ar direto (sem seu computador ligado)

Você precisa de uma hospedagem que rode Node.js. Lá dentro:

1. Coloque o projeto e rode `npm install`.
2. Crie o arquivo `.env` com `npm run configurar`.
3. Troque, dentro do `.env`:
   - `NODE_ENV` para `production`
   - `PUBLIC_ORIGIN` para o endereço do seu site (ex: `https://tela.seusite.com`)
4. Rode `npm start`.

No site do Discord, troque o *Target* e o *Redirect* pelo endereço do seu site.
Aí nenhum túnel é necessário.

---

## Comandos, resumidos

| Comando | Para quê |
|---|---|
| `iniciar.bat` | No Windows: prepara tudo e abre um menu interativo. |
| `npm install` | Baixa o que o programa precisa. Só na primeira vez. |
| `npm run start:fast` | **Liga tudo.** Configura se faltar, e sobe numa janela só. |
| `npm run tunel:criar` | Uma vez só: cria um endereço fixo, que não muda mais. |
| `npm run configurar` | Refaz as perguntas da configuração. |
| `npm run smoke` | Confere se está tudo funcionando por dentro. |

Para quem mexe no código:

| Comando | Para quê |
|---|---|
| `npm run dev` | Site, servidor e túnel juntos, remontando a cada arquivo salvo. |
| `npm run dev:rapido` | O mesmo, mas com endereço descartável e sem tocar no `.env`. |
| `npm start` | Monta o site e sobe só o servidor, sem túnel. |
| `npm run tunel` | Só o túnel, numa janela separada. |

---

## O que ainda não dá

- **Compartilhar do celular.** Nenhum navegador de celular permite.
- **Som de programa instalado** em tela cheia. Só som de aba (veja acima).
- **Muita gente ao mesmo tempo.** Cada pessoa assistindo consome a qualidade
  escolhida, inteira. Em 2,5 Mb/s, cinco pessoas já são 12,5 Mb/s de subida; em
  8 Mb/s, são 40.
- **60 fps em qualquer computador.** Se o navegador não tiver codificação por
  hardware, ele não dá conta de 60 quadros em tela grande e entrega menos. A
  página de captura avisa quando isso acontece.
- **Mais de 4 telas ao mesmo tempo** na mesma sala.

Se você mexe em código e quer entender as decisões por trás disso,
veja [docs/como-funciona.md](docs/como-funciona.md).
