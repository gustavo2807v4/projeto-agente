# Gênesis — Agente de Produtividade Inteligente

Gênesis é um **PWA de produtividade pessoal** com um agente de IA integrado. Além de organizar tarefas, hábitos, notas e humor, ele conversa com você, entende o contexto do seu dia e age por conta própria — criando tarefas, marcando hábitos ou montando um briefing proativo quando faz sentido.

> **Stack:** Vite · JavaScript puro (ESM) · Firebase / Firestore · Agente IA via Groq (tool calling) · PWA

### 📸 Telas

**Tela inicial — o agente criando tarefas pelo chat**

![Tela inicial do Gênesis com o agente criando tarefas](docs/screenshot-tarefas.png)

**Rastreador de hábitos — sequências (streaks) e criação de hábitos por conversa**

![Rastreador de hábitos do Gênesis com sequências](docs/screenshot-habitos.png)

---

## ✨ Funcionalidades

- **Agente de IA conversacional** — chat que entende o seu contexto e executa ações através de _tool calling_ (criar tarefas, agendar compromissos com horário, marcar hábitos, etc.). Tem regras de "quando **não** usar ferramentas" pra não sair criando tarefa em toda saudação.
- **Briefing proativo** — resumo de "bom dia / boa tarde / boa noite" que destaca tarefas do dia, sequências de hábitos e lembretes de humor, com sugestões quando há tarefas atrasadas.
- **Tarefas** — criação, prazos, agendamento com horário e integração opcional com o Google Calendar.
- **Hábitos** — rastreador com a grade dos últimos 7 dias e cálculo de sequência (_streak_).
- **Notas, humor e captura rápida** — registre ideias, estados de humor e anotações soltas em segundos.
- **Relatório semanal** — panorama do progresso com detecção de tarefas "zumbi" (adiadas demais).
- **Busca** — busca difusa (fuzzy) em todo o conteúdo com Fuse.js.
- **Sync na nuvem** — dados sincronizados via Firestore entre dispositivos.
- **Backup, lembretes, comando de voz e tema claro/escuro.**
- **Instalável** — funciona como app (PWA) no celular e no desktop.

---

## 🧠 O agente

O núcleo de IA vive em `src/agent/` e é a camada onde entram as funcionalidades novas:

- **Provedor:** [Groq](https://groq.com/) — modelos `gpt-oss-120b` / `gpt-oss-20b`, com `llama-3.3-70b-versatile` como fallback.
- **Tool calling:** o agente decide quando chamar ferramentas (`src/agent/tools.js`) para agir no app.
- **Memória de ações:** cada resposta guarda um log das ferramentas executadas, reinjetado no histórico para dar continuidade às conversas.
- **Roteamento e recuperação de contexto:** `router.js` e `retrieval.js` selecionam o modelo e o contexto certos para cada mensagem.

---

## 🚀 Rodando localmente

Pré-requisitos: **Node.js** e um projeto **Firebase**.

```bash
# 1. Instale as dependências
npm install

# 2. Configure as variáveis de ambiente
#    Copie o exemplo e preencha com as chaves do seu projeto Firebase
#    (Console > Configurações do projeto > Seus apps > Configuração do SDK)
cp .env.example .env.local

# 3. Suba o servidor de desenvolvimento
npm run dev
```

Outros scripts:

```bash
npm run build      # build de produção
npm run preview    # pré-visualiza o build
npm test           # testes end-to-end (Playwright)
```

### Variáveis de ambiente

Preencha o `.env.local` com as credenciais do Firebase:

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=seu-projeto.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=seu-projeto
VITE_FIREBASE_STORAGE_BUCKET=seu-projeto.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

---

## 🗂️ Estrutura do projeto

```
src/
├── main.js            # entry point (~130 linhas)
├── state.js           # estado global
├── utils.js           # helpers
├── db.js              # persistência local
├── firebase.js        # inicialização do Firebase
├── agent/             # camada de IA (chat, briefing, tools, memória, providers)
├── features/          # tarefas, hábitos, notas, humor, captura, relatório,
│                      # busca, backup, lembretes, voz, tema, briefing, perfil
└── integrations/      # Google Calendar, sync na nuvem
```

---

## 🛠️ Tecnologias

- **Build:** [Vite](https://vitejs.dev/) + [vite-plugin-pwa](https://vite-pwa-org.netlify.app/)
- **Frontend:** JavaScript puro (ES Modules), sem framework
- **Backend/dados:** [Firebase](https://firebase.google.com/) (Firestore)
- **IA:** [Groq](https://groq.com/) com tool calling
- **Busca:** [Fuse.js](https://fusejs.io/)
- **Testes:** [Playwright](https://playwright.dev/)
- **Deploy:** [Vercel](https://vercel.com/)

---

## 📄 Licença

Projeto pessoal. Sinta-se à vontade para explorar o código.
