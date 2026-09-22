import React, { useEffect, useState } from "react";
import { api } from "./api.js";

const initialTarget = { connectionId: "", repository: "", number: "" };
const initialComment = { kind: "general", path: "", line: "", side: "RIGHT", commentId: "", discussionId: "", body: "" };
const initialCorrection = { commitMessage: "", path: "", content: "", operation: "update" };

function errorMessage(error) {
    return error instanceof Error ? error.message : "Não foi possível concluir a operação.";
}

function detailsFrom(context) {
    return context.files || [];
}

export function App() {
    const [connections, setConnections] = useState([]);
    const [repositories, setRepositories] = useState([]);
    const [repositoriesLoading, setRepositoriesLoading] = useState(false);
    const [repositoriesError, setRepositoriesError] = useState("");
    const [changeRequests, setChangeRequests] = useState([]);
    const [changeRequestsLoading, setChangeRequestsLoading] = useState(false);
    const [changeRequestsError, setChangeRequestsError] = useState("");
    const [target, setTarget] = useState(initialTarget);
    const [comment, setComment] = useState(initialComment);
    const [mode, setMode] = useState("review");
    const [correction, setCorrection] = useState(initialCorrection);
    const [context, setContext] = useState(null);
    const [preview, setPreview] = useState(null);
    const [confirmed, setConfirmed] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        async function loadConnections() {
            try {
                const items = await api.connections();
                setConnections(items);
                if (items[0]) setTarget((current) => ({ ...current, connectionId: items[0].id }));
            } catch (requestError) {
                setError(errorMessage(requestError));
            }
        }
        void loadConnections();
    }, []);

    useEffect(() => {
        if (!target.connectionId) return undefined;
        let cancelled = false;
        async function loadRepositories() {
            setRepositoriesLoading(true);
            setRepositoriesError("");
            try {
                const result = await api.repositories(target.connectionId);
                if (!cancelled) setRepositories(result.repositories);
            } catch (requestError) {
                if (!cancelled) {
                    setRepositories([]);
                    setRepositoriesError(errorMessage(requestError));
                }
            } finally {
                if (!cancelled) setRepositoriesLoading(false);
            }
        }
        void loadRepositories();
        return () => {
            cancelled = true;
        };
    }, [target.connectionId]);

    useEffect(() => {
        if (!target.connectionId || !target.repository) {
            setChangeRequests([]);
            return undefined;
        }
        let cancelled = false;
        async function loadChangeRequests() {
            setChangeRequestsLoading(true);
            setChangeRequestsError("");
            try {
                const result = await api.changeRequests(target);
                if (!cancelled) setChangeRequests(result.changeRequests);
            } catch (requestError) {
                if (!cancelled) {
                    setChangeRequests([]);
                    setChangeRequestsError(errorMessage(requestError));
                }
            } finally {
                if (!cancelled) setChangeRequestsLoading(false);
            }
        }
        void loadChangeRequests();
        return () => {
            cancelled = true;
        };
    }, [target.connectionId, target.repository]);

    function updateTarget(event) {
        const { name, value } = event.target;
        setTarget((current) =>
            name === "connectionId"
                ? { ...current, connectionId: value, repository: "", number: "" }
                : { ...current, [name]: value },
        );
    }

    function updateComment(event) {
        const { name, value } = event.target;
        setComment((current) => ({ ...current, [name]: value }));
    }

    function updateCorrection(event) {
        const { name, value } = event.target;
        setCorrection((current) => ({ ...current, [name]: value }));
    }

    function targetInput() {
        return { ...target, number: Number(target.number) };
    }

    async function loadContext(event) {
        event.preventDefault();
        setLoading(true);
        setError("");
        setPreview(null);
        setResult(null);
        try {
            setContext(await api.context(targetInput()));
        } catch (requestError) {
            setError(errorMessage(requestError));
            setContext(null);
        } finally {
            setLoading(false);
        }
    }

    async function createPreview(event) {
        event.preventDefault();
        setLoading(true);
        setError("");
        setResult(null);
        try {
            const preparedComment = {
                kind: comment.kind,
                body: comment.body,
                ...(comment.kind === "inline" ? { path: comment.path, line: Number(comment.line), side: comment.side } : {}),
                ...(comment.kind === "reply" ? { ...(comment.commentId ? { commentId: Number(comment.commentId) } : {}), ...(comment.discussionId ? { discussionId: comment.discussionId } : {}) } : {}),
            };
            const input = targetInput();
            const response = mode === "review"
                ? await api.previewReview({ ...input, comments: [preparedComment] })
                : mode === "response"
                    ? await api.previewResponse({ ...input, comments: [preparedComment] })
                    : await api.previewCorrection({
                        ...input,
                        correction: {
                            commitMessage: correction.commitMessage,
                            files: [{ path: correction.path, content: correction.content, operation: correction.operation }],
                        },
                        replies: [preparedComment],
                    });
            setPreview(response);
            setConfirmed(false);
        } catch (requestError) {
            setError(errorMessage(requestError));
        } finally {
            setLoading(false);
        }
    }

    async function publish() {
        if (!preview || !confirmed) return;
        setLoading(true);
        setError("");
        try {
            setResult(await api.execute(preview.actionId));
            setPreview(null);
            setConfirmed(false);
        } catch (requestError) {
            setError(errorMessage(requestError));
        } finally {
            setLoading(false);
        }
    }

    return (
        <main>
            <header>
                <p className="eyebrow">Localhost · revisão segura</p>
                <h1>Code Review MCP</h1>
                <p>Carregue uma PR/MR, prepare um comentário e publique somente após confirmação explícita.</p>
            </header>
            {error && <p className="notice error" role="alert">{error}</p>}
            <section className="card">
                <h2>Destino</h2>
                <form onSubmit={loadContext} className="form-grid">
                    <label>Conexão<select name="connectionId" value={target.connectionId} onChange={updateTarget} required>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.id} · {connection.provider}</option>)}</select></label>
                    <label>Repositório<select name="repository" value={target.repository} onChange={updateTarget} disabled={repositoriesLoading || Boolean(repositoriesError) || repositories.length === 0} required><option value="">{repositoriesLoading ? "Carregando repositórios..." : repositoriesError ? "Não foi possível carregar os repositórios" : "Selecione um repositório"}</option>{repositories.map((repository) => <option key={repository} value={repository}>{repository}</option>)}</select>{repositoriesError && <span className="repository-error">{repositoriesError}</span>}</label>
                    <label>Número da PR/MR<input name="number" list="change-requests" type="number" min="1" value={target.number} onChange={updateTarget} required /><datalist id="change-requests">{changeRequests.map((changeRequest) => <option key={changeRequest.number} value={changeRequest.number} label={changeRequest.title} />)}</datalist>{changeRequestsLoading && <span>Carregando PRs/MRs...</span>}{changeRequestsError && <span className="repository-error">{changeRequestsError}</span>}</label>
                    <button disabled={loading}>Carregar contexto</button>
                </form>
            </section>
            {context && <section className="card"><h2>{context.title || `#${context.number}`}</h2><p>{context.provider} · {context.repository} · <code>{context.sourceBranch}</code> → <code>{context.targetBranch}</code></p><p className={context.reviewAllowed ? "notice success" : "notice error"}>{context.instruction}</p><h3>Arquivos alterados</h3><ul>{detailsFrom(context).map((file) => <li key={file.filename || file.new_path}>{file.filename || file.new_path || file.old_path}</li>)}</ul></section>}
            {context?.reviewAllowed && <section className="card"><h2>Preparar publicação</h2><form onSubmit={createPreview} className="form-grid"><label>Operação<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="review">Comentário de review</option><option value="response">Resposta a observação</option><option value="correction">Correção e resposta</option></select></label><label>Tipo de comentário<select name="kind" value={comment.kind} onChange={updateComment}><option value="general">Geral</option>{mode === "review" && <option value="inline">Inline</option>}{mode !== "review" && <option value="reply">Resposta em thread</option>}</select></label>{comment.kind === "inline" && <><label>Arquivo<input name="path" value={comment.path} onChange={updateComment} required /></label><label>Linha alterada<input name="line" type="number" min="1" value={comment.line} onChange={updateComment} required /></label><label>Lado<select name="side" value={comment.side} onChange={updateComment}><option value="RIGHT">RIGHT (novo)</option><option value="LEFT">LEFT (anterior)</option></select></label></>}{comment.kind === "reply" && <><label>ID da discussão (GitLab)<input name="discussionId" value={comment.discussionId} onChange={updateComment} /></label><label>ID do comentário (GitHub)<input name="commentId" type="number" min="1" value={comment.commentId} onChange={updateComment} /></label></>}{mode === "correction" && <><label>Mensagem do commit<input name="commitMessage" value={correction.commitMessage} onChange={updateCorrection} required /></label><label>Arquivo a corrigir<input name="path" value={correction.path} onChange={updateCorrection} required /></label><label>Operação<select name="operation" value={correction.operation} onChange={updateCorrection}><option value="update">Atualizar</option><option value="create">Criar</option><option value="delete">Excluir</option></select></label>{correction.operation !== "delete" && <label className="wide">Conteúdo completo do arquivo<textarea name="content" value={correction.content} onChange={updateCorrection} required rows="8" /></label>}</>}<label className="wide">{mode === "correction" ? "Resposta à thread" : "Comentário"}<textarea name="body" value={comment.body} onChange={updateComment} required rows="5" /></label><button disabled={loading}>Gerar prévia</button></form></section>}
            {preview && <section className="card preview"><h2>Confirmação necessária</h2><pre>{preview.previewMarkdown}</pre><label className="confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Li e confirmo a publicação deste conteúdo.</label><button onClick={publish} disabled={!confirmed || loading}>Publicar comentário</button></section>}
            {result && <section className="card"><p className="notice success">Publicação concluída.</p><pre>{JSON.stringify(result, null, 2)}</pre></section>}
        </main>
    );
}
