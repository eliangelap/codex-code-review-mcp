# Codex Code Review MCP

Servidor MCP local e interface web para revisar Merge Requests do GitLab e Pull Requests do GitHub. O projeto concentra a coleta de contexto, a preparação de comentários, respostas e correções, e só publica uma alteração remota após uma prévia e confirmação explícita da pessoa usuária.

## O que o projeto faz

- Conecta-se a instâncias GitLab (SaaS ou self-managed) e GitHub (incluindo GitHub Enterprise Server).
- Restringe o acesso a conexões e repositórios previamente autorizados em uma allowlist.
- Carrega PRs/MRs abertas, branches, diff, arquivos alterados e discussões.
- Detecta a stack alterada e exige a skill de revisão correspondente: Laravel/PHP, Node.js ou React.
- Prepara comentários de review, comentários gerais, respostas a threads e commits de correção.
- Oferece a mesma operação por MCP (stdin/stdout JSON-RPC) e por uma UI React servida apenas em localhost.

Não é um bot de revisão autônomo: não executa polling, webhooks ou publicação automática.

## Salvaguardas de publicação

O fluxo de escrita foi desenhado para ser deliberado e verificável:

1. A conexão precisa existir no arquivo de configuração e o repositório precisa constar na sua allowlist.
2. Uma prévia cria um `actionId` temporário, válido por 30 minutos.
3. A publicação requer `confirmedByUser: true`; o `actionId` é consumido uma única vez.
4. Antes de publicar, o servidor consulta novamente a PR/MR e bloqueia a ação se o SHA da branch de origem mudou.
5. Respostas e correções só são aceitas para threads ainda abertas. O estado é revalidado imediatamente antes do envio.
6. Correções e respostas a observações são limitadas a PRs/MRs cujo autor é o usuário autenticado pelo token.

O servidor não realiza merge, aprovação formal, encerramento de discussão ou exclusão automática.

## Arquitetura

| Componente | Responsabilidade |
| --- | --- |
| `src/server.mjs` | Adaptador MCP JSON-RPC por stdin/stdout; expõe as ferramentas ao Codex. |
| `src/review-service.mjs` | Orquestra configuração, carregamento de contexto, validações, prévias e publicação. |
| `src/actions.mjs` | Armazena ações pendentes em memória, com expiração e consumo único. |
| `src/github-client.mjs` | Integra REST e GraphQL do GitHub para PRs, threads, comentários e commits. |
| `src/gitlab-client.mjs` | Integra API v4 do GitLab para MRs, discussões, comentários e commits. |
| `src/http-server.mjs` | API HTTP local em `127.0.0.1:9898`, reutilizando o mesmo serviço e regras. |
| `src/web-server.mjs` e `web/` | Inicializa a API e Vite; a UI React fica em `127.0.0.1:5599`. |
| `test/` | Testes nativos do Node para configuração, clientes, API HTTP e regras do fluxo. |

As ações pendentes existem somente em memória. Reiniciar o processo invalida prévias que ainda não foram publicadas.

## Compatibilidade e requisitos

- Node.js 20 ou superior.
- Um token GitLab ou GitHub acessível por variável de ambiente.
- Acesso de rede à instância configurada.
- Para uma revisão feita pelo Codex, o repositório deve estar no workspace; se não estiver, a instrução MCP determina cloná-lo antes da análise.

Instale as dependências:

```bash
npm install
```

## Configuração de conexões

Copie [connections.example.json](connections.example.json) para um dos locais abaixo:

- padrão: `~/.config/codex-code-review-mcp/connections.json`;
- personalizado: defina a variável `CODE_REVIEW_CONNECTIONS_FILE` com o caminho absoluto do arquivo.

O arquivo contém URLs, identificadores, allowlists e o nome da variável de ambiente do token. **Nunca inclua tokens nele.**

```json
{
  "connections": [
    {
      "id": "gitlab-corporativo",
      "provider": "gitlab",
      "baseUrl": "https://gitlab.example.com",
      "tokenEnv": "CODE_REVIEW_GITLAB_CORPORATIVO_TOKEN",
      "allowedRepositories": ["grupo/api-exemplo"]
    },
    {
      "id": "github",
      "provider": "github",
      "baseUrl": "https://api.github.com",
      "tokenEnv": "CODE_REVIEW_GITHUB_TOKEN",
      "allowedRepositories": ["organization/*"]
    }
  ]
}
```

`allowedRepositories` aceita o nome exato do repositório (`owner/repository` ou `grupo/projeto`). Apenas no GitHub, `owner/*` autoriza os repositórios diretamente pertencentes a esse owner; outros curingas são rejeitados ao iniciar.

Para GitLab self-managed, informe a URL raiz da instância; o cliente acrescenta `/api/v4` quando necessário. Para GitHub Enterprise Server, informe normalmente a URL da API, como `https://github.empresa.com/api/v3`.

Exemplos de variáveis de ambiente:

```powershell
$env:CODE_REVIEW_GITLAB_CORPORATIVO_TOKEN = "glpat-..."
$env:CODE_REVIEW_GITHUB_TOKEN = "github_pat_..."
```

```bash
export CODE_REVIEW_GITLAB_CORPORATIVO_TOKEN='glpat-...'
export CODE_REVIEW_GITHUB_TOKEN='github_pat_...'
```

Reinicie o processo do MCP após alterar variáveis ou a configuração. Em macOS, aplicações abertas pelo Finder podem não herdar variáveis exportadas pelo shell.

## Permissões recomendadas

### GitLab

O cliente usa o cabeçalho `PRIVATE-TOKEN` e a API REST. Prefira Project Access Token para um projeto ou Group Access Token para um conjunto limitado de projetos.

| Operação | Escopo | Papel mínimo | Observação |
| --- | --- | --- | --- |
| Ler MR, diff, discussões e criar prévia | `read_api` | Reporter | Não publica. |
| Publicar comentário ou resposta | `api` | Reporter | O comentário é atribuído ao dono do token. |
| Criar commit na branch de origem | `api` | Developer | Exige permissão de push; em branch protegida, configure a regra apropriada. |

Para cobrir todas as operações com um único token, use `api` e papel Developer. `write_repository` não é necessário, pois os commits são criados pela API REST, não por Git-over-HTTP.

### GitHub

O token deve poder ler repositórios, Pull Requests, arquivos/diffs e comentários. Para publicar, também deve ter permissão de escrever comentários de issue/review; para correções, precisa poder atualizar a branch de origem. Em GitHub Enterprise Server, confirme que a API GraphQL está disponível: ela é consultada para verificar se uma review thread foi resolvida.

Use tokens de menor privilégio, com validade curta e rotação regular.

## Registro como MCP no Codex

No macOS/Linux, ajuste o caminho do projeto e execute:

```bash
codex mcp add code-review \
  --env CODE_REVIEW_GITLAB_CORPORATIVO_TOKEN="$CODE_REVIEW_GITLAB_CORPORATIVO_TOKEN" \
  --env CODE_REVIEW_GITHUB_TOKEN="$CODE_REVIEW_GITHUB_TOKEN" \
  -- node /caminho/para/codex-code-review-mcp/src/server.mjs
```

No Windows PowerShell:

```powershell
codex mcp add code-review `
  --env CODE_REVIEW_GITLAB_CORPORATIVO_TOKEN="$env:CODE_REVIEW_GITLAB_CORPORATIVO_TOKEN" `
  --env CODE_REVIEW_GITHUB_TOKEN="$env:CODE_REVIEW_GITHUB_TOKEN" `
  -- node C:\caminho\para\codex-code-review-mcp\src\server.mjs
```

Inclua um `--env` para cada `tokenEnv` existente no arquivo de conexões. Abra uma nova sessão e use `/mcp` para confirmar que o servidor está disponível.

## Ferramentas MCP

| Ferramenta | Tipo | Finalidade |
| --- | --- | --- |
| `code_review_list_connections` | Leitura | Lista conexões sem expor tokens. |
| `code_review_list_repositories` | Leitura | Lista repositórios permitidos/visíveis para uma conexão. |
| `code_review_load_context` | Leitura | Carrega PR/MR, branches, arquivos, diff e instruções de revisão. |
| `code_review_preview_review` | Prévia | Monta comentários inline ou gerais sem publicar. |
| `code_review_preview_response` | Prévia | Monta respostas para observações de uma thread aberta. |
| `code_review_preview_correction` | Prévia | Mostra commit de correção e respostas antes do envio. |
| `code_review_execute` | Escrita | Publica exatamente uma prévia já confirmada. |

Uma revisão é bloqueada quando a alteração não corresponde a uma stack suportada. A detecção é feita pelos arquivos modificados:

- Laravel/PHP: arquivos `.php`, `artisan`, `composer.*` ou diretórios Laravel usuais;
- React: `.jsx`, `.tsx` ou caminhos com `@presentation`;
- Node.js: `.js`, `.ts`, `.mjs`, `.cjs` ou caminhos com `@server`/`@worker`.

Comentários de achados no diff precisam ser `inline` e apontar para uma linha efetivamente modificada, do lado `RIGHT` (novo) ou `LEFT` (anterior). Achados fora do diff devem ser comentários gerais.

## Fluxo de uso

1. Carregue o contexto, por exemplo: “Revise o PR 42 em `acme/web`, na conexão `github`”.
2. O Codex identifica a skill exigida, compara a branch de origem com a de destino e monta uma prévia de comentários.
3. Revise a prévia e confirme explicitamente nesta conversa.
4. O Codex chama `code_review_execute` com o `actionId` e `confirmedByUser: true`.

Para uma observação existente, primeiro solicite a avaliação técnica. Antes de preparar uma resposta ou correção, o Codex deve apresentar separadamente um plano de correção e um plano de resposta. Quando a observação for válida, a correção é publicada antes da resposta, que recebe o SHA efetivo do commit. Quando for inválida, apenas a justificativa técnica é publicada na mesma thread.

## Interface web local

Com os tokens e o arquivo de conexões já configurados:

```bash
npm run start:web
```

O comando inicia conjuntamente:

- API HTTP: `http://localhost:9898`;
- interface React: `http://localhost:5599`.

A API escuta apenas em `127.0.0.1` e aceita CORS somente das origens locais da interface. A UI nunca recebe o token; ela chama a API local, que preserva allowlist, prévia, expiração e confirmação. Use `npm run start:web:client` quando a API já estiver ativa e `npm run build:web` para gerar os arquivos estáticos em `dist/`.

Endpoints locais disponíveis:

| Método | Rota | Finalidade |
| --- | --- | --- |
| `GET` | `/api/health` | Health check. |
| `GET` | `/api/connections` | Conexões públicas, sem tokens. |
| `GET` | `/api/repositories?connectionId=...` | Repositórios permitidos/visíveis. |
| `GET` | `/api/change-requests?connectionId=...&repository=...` | PRs/MRs abertas. |
| `POST` | `/api/context` | Contexto de uma PR/MR. |
| `POST` | `/api/preview/review` | Prévia de review. |
| `POST` | `/api/preview/response` | Prévia de resposta. |
| `POST` | `/api/preview/correction` | Prévia de correção e resposta. |
| `POST` | `/api/execute` | Executa uma prévia confirmada. |

## Desenvolvimento e validação

| Comando | Descrição |
| --- | --- |
| `npm start` | Inicia o servidor MCP. |
| `npm run start:api` | Inicia somente a API HTTP local. |
| `npm run start:web` | Inicia API e interface local. |
| `npm run start:web:client` | Inicia somente o Vite em `127.0.0.1:5599`. |
| `npm run build:web` | Gera a interface estática em `dist/`. |
| `npm test` | Executa a suíte de testes com `node --test`. |

Os testes cobrem expiração e confirmação de ações, allowlist, configuração, clientes GitHub/GitLab, detecção de stack, validação de comentários inline, proteção contra atualização remota, estado de threads e API HTTP.

## Limitações atuais

- As prévias pendentes não sobrevivem ao reinício do processo.
- A interface permite preparar uma entrada por vez; a API e o MCP aceitam lotes de comentários.
- A listagem de arquivos da PR/MR usa páginas de até 100 itens conforme a API remota; para mudanças maiores, valide se a instância fornece todos os arquivos necessários à análise.
- Somente Laravel/PHP, Node.js e React são elegíveis para o fluxo de revisão automatizado pelo MCP.
