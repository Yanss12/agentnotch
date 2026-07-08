# AgentNotch

Widget de desktop estilo *dynamic island* que mostra, em tempo real, o que os seus agentes do **Claude Code** estão fazendo — fixado no topo-centro da tela, sempre visível.

```
● 2 agents · 215k today · 1 needs you
```

Passe o mouse e ele expande num dashboard com um card por sessão ativa:

- **Status ao vivo**: `WORKING` (verde, pulsando), `NEEDS YOU` (laranja — o agente terminou e espera sua resposta), `IDLE` (cinza, conversa encerrada)
- **Projeto · branch** e a última ação executada
- **Modelo** (Opus, Fable, Sonnet…), **tokens gastos** na sessão e **subagents ativos** (`→ uraraka +5`)
- **Barra de contexto** real da janela (input + cache)
- **Uso do plano** (janelas 5h/7d) direto da API da Anthropic
- Total de **tokens do dia** na pílula

100% local: lê os logs de sessão que o Claude Code já grava em `~/.claude/projects/`. Nenhum dado sai da sua máquina (a única chamada externa é o endpoint oficial de uso da Anthropic, com o seu próprio token).

## Instalação

Baixe o instalador do seu sistema em [**Releases**](https://github.com/Mystic0112/Agentnotch/releases):

| Sistema | Arquivo |
|---|---|
| Linux | `AgentNotch-x.y.z.AppImage` (qualquer distro) ou `.deb` (Ubuntu/Pop!_OS/Debian) |
| Windows | `AgentNotch-Setup-x.y.z.exe` |
| macOS | `AgentNotch-x.y.z.dmg` (Intel e Apple Silicon) |

> macOS: o app não é assinado — na primeira abertura, clique com o botão direito → **Abrir**.

Pré-requisito: [Claude Code](https://claude.com/claude-code) instalado e usado ao menos uma vez (o widget lê `~/.claude/projects/`).

## Uso

- **Hover** na pílula expande o dashboard; tirar o mouse recolhe
- **▾ (chevron)** trava o dashboard aberto (pin); clique de novo pra soltar
- **Arraste** pela pílula pra reposicionar
- **Ícone na bandeja**: Mostrar/Ocultar · Sair

## Desenvolvimento

```bash
git clone https://github.com/Mystic0112/Agentnotch.git
cd Agentnotch
npm install
npm start
```

Build local: `npm run build:linux` / `build:win` / `build:mac` (cada um no seu SO). Releases oficiais saem do GitHub Actions ao empurrar uma tag `v*`.

## Stack

Electron + HTML/CSS puro. Sem dependências de runtime. O main process parseia os JSONL de sessão (com cache por mtime) e empurra telemetria pro renderer a cada 2s via IPC isolado (`contextIsolation`, sem `nodeIntegration`).
