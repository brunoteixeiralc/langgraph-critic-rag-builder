# Agentic Workflow para o LinkedIn: Arquitetura e Prompts

Este documento detalha a arquitetura, o fluxo de dados e os prompts de sistema de um ecossistema multi-agentes projetado para gerar publicações técnicas de alto nível no LinkedIn.

---

## 1. Visão Geral do Sistema
Um sistema multi-agentes baseado em **LangGraph** focado em gerar posts técnicos de altíssima qualidade em **Inglês (US)**.

*   **Estratégia de SSI (Social Selling Index):** O sistema não publica diretamente via API. Ele gera os artefatos (texto e imagens do código) em uma pasta local (`/output`) para publicação manual (*Human-in-the-Loop*), evitando penalizações de automação pela plataforma.
*   **Tech Stack:** Node.js, `@langchain/langgraph` (orquestração), `zod` (Structured Outputs), `OpenRouter` (roteamento de LLMs), `Pinecone` + `@langchain/google-genai` (RAG via `embedding-001`), e API do `Carbonara` (geração de imagens de código).

---

## 2. O Estado do Grafo (State Schema)
O objeto que transita entre todos os nós do sistema:

*   `initialCommand`: O pedido original do usuário.
*   `niche`: Classificação do tema (`flutter_dart`, `node_react` ou `ai_engineering`).
*   `ragContext`: Conhecimento profundo extraído do banco vetorial.
*   `mcpContext`: Dados de documentação ao vivo (opcional).
*   `technicalDraft`: O texto cru escrito pelo especialista.
*   `codeSnippets`: Array isolando os blocos de código.
*   `reviewFeedback`: Apontamentos de correção do Revisor.
*   `finalPostText`: O texto polido e formatado para o LinkedIn.
*   `hashtags`: Array com as hashtags selecionadas.
*   `reviewCount`: Contador de loops de revisão (Guardrail: limite de 3 tentativas).

---

## 3. Arquitetura de Roteamento (Edge Conditions)
1.  **Entrada:** O comando vai para o `Orquestrador`.
2.  **Roteador de Nicho:** Avalia o `niche` e direciona para o Especialista correspondente.
3.  **Loop de Revisão:** Todo especialista envia o rascunho para o `Revisor`.
    *   *Reprovado:* O fluxo volta para o Especialista com o `reviewFeedback` e o `reviewCount` sobe +1.
    *   *Aprovado (ou limite estourado):* O fluxo avança para o `Extrator de Imagens`.
4.  **Saída:** O `Extrator de Imagens` salva tudo na máquina local e encerra o fluxo.

---

## 4. Catálogo de Agentes e System Prompts

### A. Agente Orquestrador (O Despachante)
*   **Responsabilidade:** Analisar a intenção do usuário e classificar o tema estritamente em uma das três categorias via Structured Outputs.
*   **System Prompt:**
    ```text
    You are a Technical Dispatcher for an automated LinkedIn content creation system. Your only job is to analyze the user's initial command and classify it into one of three specific technical niches: 'flutter_dart', 'node_react', or 'ai_engineering'. Focus on the core architectural intent. Output your reasoning and the exact niche.
    ```

### B. Agentes Especialistas (Os Engenheiros)
*   **Responsabilidade:** Consumir o RAG e escrever a matéria-prima técnica pura, densa e com código funcional.
*   **Mecânica de Código:** Nunca misturar código no texto markdown. Usar `[CODE_SNIPPET_X]` no texto e popular a variável `codeSnippets` com o código cru.

**Prompt: Especialista em Flutter/Dart**
```text
You are a Senior Mobile & Full Stack Software Engineer specializing in Flutter and Dart. 
Persona: Pragmatic executor, over 6 years experience. PROHIBITED: Never use 'Tech Lead' or management titles. 
Task: Write a deep, technical draft in professional US English about the given topic. Focus on architecture and under-the-hood concepts. 
Code Separation: Replace actual code with [CODE_SNIPPET_X] in the text, and put the raw compilable Dart code in the 'codeSnippets' array.

---

## 5. Diretrizes de Prompt Engineering para o Usuário

Para obter os melhores resultados consistentes e evitar que o modelo alucine prioridades ou estrutura, o prompt inicial (`initialCommand`) deve minimizar a ambiguidade. Quanto mais o prompt resolver decisões editoriais, menos o LLM precisará inventá-las.

**Formato Recomendado para o Prompt:**
```text
Make a LinkedIn post about [TOPIC] based on the official announcement: [URL]

Target audience: [PROFILE - e.g., Senior Node.js/TypeScript developers working on medium-to-large codebases].

Priorities — cover these topics in this order:
1. [PRIORITY 1 - e.g., What TS 7.0 actually is (Go rewrite, not a language change)]
2. [PRIORITY 2 - e.g., Real-world performance benchmarks from the blog (cite exact numbers)]
3. [PRIORITY 3 - e.g., The compatibility strategy: @typescript/typescript6]
4. [PRIORITY 4 - e.g., What to do today: install command + what to watch out for]

Tone: [TONE - e.g., direct and pragmatic — no hype, no fluff. Speak engineer-to-engineer].
Format: [STRUCTURE - e.g., short intro hook -> 3–4 bullet sections -> closing question for engagement].
Length: [LENGTH - e.g., around 250–350 words].
```

**Por que cada adição importa:**

*   **`Target audience`**: O especialista escreve com o nível técnico correto desde a primeira tentativa. Sem isso, ele oscila entre explicar o básico e assumir conhecimentos extremamente avançados.
*   **`Priorities` com ordem explícita**: Elimina a aleatoriedade sobre o que o post deve abordar e o que deve ser cortado. O modelo para de inventar prioridades e segue as suas diretrizes.
*   **`Tone` (ex: `direct and pragmatic`)**: Evita que o resultado saia cheio de termos clichês de marketing ou *hype words*. Reforça a instrução do system prompt para manter a consistência em todas as execuções.
*   **`Format`**: Define a estrutura do post (ex: hook -> bullets -> pergunta), o que permite ao Revisor validar com critérios claros e estruturais em vez de apenas avaliar subjetivamente "se ficou bom".
*   **`Length` (ex: `~250–350 words`)**: Mantém a densidade ideal. O LinkedIn funciona bem nessa faixa de palavras para posts técnicos. Sem isso, uma instrução de "short post" pode virar de 80 a 600 palavras dependendo de como o modelo interpreta.
*   **Inferência de Código/Imagens (`Code & Image Inference`)**: O sistema infere automaticamente pelo prompt se deve ou não gerar imagens de código:
    * Se você solicitar/mencionar código no prompt (ex: *"Show code examples"*, *"Create code in Python"*, *"how to write..."* ou tópicos práticos), o agente gerará os arquivos de código cru e as imagens PNG via Carbonara API.
    * Se o pedido for conceitual ou estritamente texto (ex: *"text-only post"*, tópicos conceituais de arquitetura sem código), o agente gerará um post 100% texto limpo sem criar imagens desnecessárias ou placeholders falsos.