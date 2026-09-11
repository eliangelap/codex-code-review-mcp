# Codex Code Review MCP

Servidor MCP local para revisar manualmente Merge Requests do GitLab e Pull Requests do GitHub, sempre com confirmação explícita antes de criar comentários, respostas ou commits.

## Segurança e limites

- Não executa webhook, polling ou tarefas automáticas.
- Não faz merge, aprovação formal, exclusão ou resolve discussões automaticamente.
- Só permite os projetos e repositórios definidos na allowlist da conexão.
- Não publica sem uma prévia aprovada nesta conversa e um `actionId` ainda válido.
- Não responde nem prepara correções para threads já resolvidas; o estado é revalidado imediatamente antes da publicação.
- Para cada thread não resolvida, o Codex avalia tecnicamente a observação. Quando válida, prepara a correção, cria o commit na branch de origem e responde à mesma thread com o SHA do commit; quando inválida, responde à mesma thread com justificativa técnica. Todas as escritas permanecem sujeitas à confirmação explícita.
- Para review, o Codex deve aplicar `code-review-nodejs` ou `code-review-reactjs`. MRs/PRs sem stack suportada são bloqueados.

## Configuração

Crie `~/.config/codex-code-review-mcp/connections.json` a partir de [connections.example.json](connections.example.json). O arquivo contém apenas URLs, allowlists e os nomes das variáveis de ambiente; não coloque tokens nele.

Exemplo de variáveis globais no macOS:

```zsh
export CODE_REVIEW_GITLAB_CORPORATIVO_TOKEN='glpat-...'
export CODE_REVIEW_GITHUB_TOKEN='github_pat_...'
```

Reinicie o Codex após definir as variáveis. Aplicações abertas pelo Finder podem não herdar variáveis exportadas no shell; nesse caso, defina-as no ambiente que inicia o Codex e confirme com `code_review_list_connections` antes de usar o servidor.

Para GitHub Enterprise Server, use a URL da API da instância, normalmente `https://github.empresa.com/api/v3`. Para GitLab self-managed, informe a URL raiz da instância; o servidor usa `/api/v4` automaticamente.

## Permissões no GitLab

O servidor autentica na API REST do GitLab pelo cabeçalho `PRIVATE-TOKEN` e chama os endpoints de Merge Request, alterações, discussões, usuário autenticado e criação de commits. Prefira um **Project Access Token** (para um único projeto) ou um **Group Access Token** (para vários projetos da mesma área), limitado aos repositórios informados em `allowedRepositories`.

| Uso das tools | Escopo do token | Papel mínimo no projeto | Observações |
| --- | --- | --- | --- |
| Carregar contexto e gerar prévias (`code_review_load_context`, `code_review_preview_*`) | `read_api` | Reporter | Lê MR, diff, discussões e o usuário autenticado; não publica nada. |
| Publicar comentários novos ou respostas (`code_review_execute` para uma prévia de review/resposta) | `api` | Reporter | O escopo `api` é necessário porque a publicação é feita pela API; o comentário ficará em nome do bot/usuário dono do token. |
| Criar commit de correção na branch de origem (`code_review_execute` para uma prévia de correção) | `api` | Developer | Também exige permissão de push para a branch de origem. Em branch protegida, inclua explicitamente o bot/usuário em **Allowed to push and merge** ou use a regra de acesso aplicável. |

Para usar todas as tools com um único token, conceda somente o escopo **`api`** e o papel **Developer** no projeto. Não é necessário habilitar `write_repository`: esta integração cria commits pela API REST, e esse escopo é exclusivo para Git-over-HTTP. Também não são necessários `sudo`, `admin_mode`, permissões de merge, de aprovação formal, de exclusão ou de gerenciamento do projeto.

Como as prévias de resposta e correção só são permitidas para MRs cuja autoria coincide com o usuário autenticado, um Project/Group Access Token deve ser usado apenas se o respectivo bot for o autor do MR. Para revisar e comentar MRs de outras pessoas, use um token de um usuário ou bot com acesso ao projeto; correções continuam restritas aos MRs de sua própria autoria.

As permissões efetivas também dependem das regras do projeto, como visibilidade, restrições de branch protegida e `CODEOWNERS`. Use um token com validade curta, rotacione-o e mantenha-o apenas na variável de ambiente indicada pela conexão.

## Registro no Codex

```zsh
codex mcp add code-review \
  --env CODE_REVIEW_GITLAB_CORPORATIVO_TOKEN="$CODE_REVIEW_GITLAB_CORPORATIVO_TOKEN" \
  --env CODE_REVIEW_GITHUB_TOKEN="$CODE_REVIEW_GITHUB_TOKEN" \
  -- node /Users/emenezes/projetos/codex-code-review-mcp/src/server.mjs
```

Inclua um `--env` para cada variável `tokenEnv` configurada no seu `connections.json`.

Abra uma nova sessão e use `/mcp` para verificar o servidor.

## Uso previsto

1. Peça ao Codex para carregar o contexto, por exemplo: “Revise o PR 42 em `acme/web`, conexão `github`”.
2. O Codex identifica a skill de review exigida, analisa o diff e apresenta uma prévia dos comentários.
3. Confirme explicitamente o lote exibido.
4. O Codex executa a ação pendente com `confirmedByUser: true`.

As prévias de respostas e correções são exibidas em Markdown no prompt, incluindo os textos a enviar, mensagem de commit e conteúdo dos arquivos modificados. Revise esse conteúdo antes de confirmar.

Para uma observação em thread não resolvida, peça para avaliá-la. Se ela for válida, o Codex prepara o diff, executa validações, revisa novamente e mostra o commit e a resposta antes de enviá-los. Após a confirmação, o MCP cria e envia o commit primeiro e responde à mesma thread com o SHA efetivamente criado. Se não for válida, mostra a justificativa técnica antes de publicá-la.

## Desenvolvimento

Requer Node.js 20 ou superior.

```zsh
npm test
```
