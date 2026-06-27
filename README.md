# Overlay Live 🎬

Overlay **interativo (drag & drop)** para lives da Twitch: os mods **arrastam memes**
(imagens, vídeos e sons) para um palco e eles aparecem na live em tempo real, na posição escolhida.
Funciona como Browser Source no OBS — sem plugin.

```
Painel do Mod  ──►  Servidor (Node)  ──►  Overlay no OBS
 (arrasta/posiciona) (Socket.IO em tempo real) (espelha o palco)
```

Stack: **React + Vite** (frontend) · **Express + Socket.IO** (backend).

## Como funciona

- O painel tem um **palco** (preview 16:9 = sua tela) e uma **bandeja** de memes embaixo.
- O mod **arrasta** uma imagem ou vídeo da bandeja pro palco → aparece na live naquela posição.
- **Reposicionar:** arraste o meme. **Redimensionar:** alça roxa no canto (ou scroll do mouse). **Remover:** ✕ ao passar o mouse.
- **Sons** tocam ao soltar (não ficam na tela). **Vídeos** tocam com som no overlay (autoplay no OBS).
- **Enviar meme:** botão no painel sobe imagem/som/vídeo na hora (veja "Armazenamento dos uploads").
- O servidor guarda a cena atual: se o OBS recarregar, o overlay recupera tudo.
- Vários mods veem o palco um do outro (e os uploads) ao vivo.

### Níveis de acesso (3 senhas)

| Ação | Admin | Super moderador | Moderador |
|------|:-----:|:---------------:|:---------:|
| Usar memes no overlay (arrastar, tocar som) | ✅ | ✅ | ✅ |
| Enviar (upload), deletar e ajustar volume dos memes | ✅ | ✅ | ❌ |
| Painel de moderação (ver conectados + expulsar) | ✅ | ❌ | ❌ |

O painel mostra um **badge** com o seu papel. O servidor decide o papel pela senha digitada.
**Volume:** admin/supermod ajustam o volume de cada som/vídeo pela barrinha na bandeja (reflete pra todos e no overlay).
**Moderação:** o admin abre **🛡️ Moderação** para ver todos os conectados (papel, IP, tempo) e **expulsar** em caso de invasão.

## Rodar em desenvolvimento

Sobe o backend (Node) + o Vite com hot-reload, juntos:

```bash
npm install
npm run dev
```

- **Painel:** http://localhost:5173/painel.html
- **Overlay:** http://localhost:5173/overlay.html?token=SEU_TOKEN

## Rodar em produção (o que vai pro OBS)

Gera o frontend e serve tudo pelo Node numa porta só:

```bash
npm run build
npm start
```

- **Painel:** http://localhost:3000/painel.html
- **Overlay (OBS):** http://localhost:3000/overlay.html?token=SEU_TOKEN

## Configuração (.env)

Copie `.env.example` para `.env` e ajuste:

```
PORT=3000
MOD_PASSWORD=...      # senha que os mods digitam no painel
OVERLAY_TOKEN=...     # token secreto que vai na URL do overlay (?token=)
```

> Você já tem um `.env` com `MOD_PASSWORD=senha123`. Troque por algo forte antes de expor na internet.

## Adicionar memes

Duas formas:

1. **Pelo painel:** botão **"+ Enviar meme"** (envia imagem/som/vídeo na hora).
2. **Pela pasta `media/`:** solte arquivos lá e eles já vêm embutidos no deploy (vão no Git).

Formatos aceitos:

- Imagens: `.png .jpg .jpeg .gif .webp`
- Sons: `.mp3 .wav .ogg .m4a .aac`
- Vídeos: `.mp4 .webm .mov`

### Armazenamento dos uploads (Cloudinary — grátis)

O disco do Render/Railway é **efêmero**: arquivos enviados em runtime somem no próximo
deploy/restart. Para persistir, use o **Cloudinary** (free tier: 25 GB):

1. Crie conta grátis em [cloudinary.com](https://cloudinary.com).
2. No Dashboard, copie o valor de **"API Environment variable"** (formato `cloudinary://...`).
3. Defina a env var `CLOUDINARY_URL` (no `.env` local ou no painel do Render/Railway).

Com `CLOUDINARY_URL` definido, os uploads vão pro Cloudinary (persistente).
Sem ele, caem na pasta local `media/` — ótimo para dev, mas não persiste no deploy.

## Configurar no OBS

1. Adicione uma fonte **Navegador / Browser Source**.
2. URL: `http://localhost:3000/overlay.html?token=SEU_TOKEN` (use a versão de produção).
3. Largura/Altura: 1920 x 1080.
4. O fundo já é transparente.
5. Áudio (sons e vídeos) do Browser Source toca dentro do OBS — confira o mixer.
   Vídeos dão autoplay com som no OBS automaticamente (no navegador comum o som fica mudo até interagir).

## Colocar online (mods remotos)

> **Importante:** este app NÃO roda no Vercel. Ele depende de um servidor
> WebSocket (Socket.IO) sempre ligado, com estado em memória — coisa que
> funções serverless não sustentam. Use Railway ou Render (suportam WebSocket).

### Render (com o `render.yaml` que já está no repo)

1. Suba o projeto pro GitHub.
2. No Render: **New +** → **Blueprint** → escolha o repositório.
3. O Render lê o `render.yaml` e configura build/start sozinho.
4. Em **Environment**, defina `MOD_PASSWORD` e `OVERLAY_TOKEN` (valores fortes) e,
   para uploads persistentes, `CLOUDINARY_URL` (veja "Armazenamento dos uploads").
5. Deploy. Use a URL pública (`https://seu-app.onrender.com/overlay.html?token=...`) no OBS.

> Plano free do Render hiberna após ~15 min sem acesso (cold start de ~30–60s ao
> abrir de novo). Para a live, basta abrir o overlay alguns minutos antes.

### Railway (alternativa)

1. Suba o projeto pro GitHub.
2. No Railway: **New Project** → **Deploy from GitHub repo**.
3. Railway detecta Node e roda `npm run build` + `npm start` automaticamente.
4. Em **Variables**, defina `MOD_PASSWORD` e `OVERLAY_TOKEN`.
5. Gere um domínio público em **Settings → Networking** e use no OBS.

## Estrutura

```
server.js              backend (Express + Socket.IO, estado da cena)
vite.config.js         build multi-página + proxy de dev
client/
  painel.html          entrada do painel
  overlay.html         entrada do overlay
  src/
    socket.js          conexão + aplicação dos eventos de cena
    painel/Painel.jsx  palco, bandeja, drag & drop
    overlay/Overlay.jsx espelha a cena, toca sons
media/                 seus memes
dist/                  frontend buildado (gerado por npm run build)
```

## Próximos passos (ideias)

- Login pela Twitch (verificar mods de verdade no canal).
- Upload de memes pelo painel.
- Suporte a vídeo (a base já comporta).
- Cooldown/fila e camadas (z-index).
- Atalhos de teclado e busca na bandeja.
