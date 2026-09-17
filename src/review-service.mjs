import { PendingActions } from "./actions.mjs";
import { GitHubClient } from "./github-client.mjs";
import { GitLabClient } from "./gitlab-client.mjs";
import { resolveConnection } from "./config.mjs";
import { ValidationError } from "./errors.mjs";

function detectReviewSkill(context) {
    const paths =
        context.provider === "gitlab"
            ? context.files.map((file) => file.new_path || file.old_path || "")
            : context.files.map((file) => file.filename || "");
    if (paths.some((path) => /\.(tsx|jsx)$/.test(path) || path.includes("/@presentation/")))
        return "code-review-reactjs";
    if (
        paths.some(
            (path) => /\.(ts|js|mjs|cjs)$/.test(path) || path.includes("/@server/") || path.includes("/@worker/"),
        )
    )
        return "code-review-nodejs";
    return null;
}

function validateComments(comments) {
    if (!Array.isArray(comments) || comments.length === 0)
        throw new ValidationError("At least one comment is required.");
    for (const comment of comments) {
        if (!comment?.body?.trim()) throw new ValidationError("Every comment requires a non-empty body.");
        if (!["inline", "general", "reply"].includes(comment.kind))
            throw new ValidationError("Comment kind must be inline, general, or reply.");
        if (
            comment.kind === "inline" &&
            (!comment.path?.trim() || !Number.isInteger(comment.line) || comment.line < 1)
        )
            throw new ValidationError("Inline comments require a file path and a positive line number.");
        if (comment.side && !["LEFT", "RIGHT"].includes(comment.side))
            throw new ValidationError("Inline comment side must be LEFT or RIGHT.");
    }
}

function changedLines(patch) {
    if (typeof patch !== "string") return null;
    const lines = { LEFT: new Set(), RIGHT: new Set() };
    let oldLine;
    let newLine;
    for (const row of patch.split("\n")) {
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
        if (header) {
            oldLine = Number(header[1]);
            newLine = Number(header[2]);
            continue;
        }
        if (oldLine === undefined || newLine === undefined || row.startsWith("\\")) continue;
        if (row.startsWith("+")) {
            lines.RIGHT.add(newLine);
            newLine += 1;
        } else if (row.startsWith("-")) {
            lines.LEFT.add(oldLine);
            oldLine += 1;
        } else {
            oldLine += 1;
            newLine += 1;
        }
    }
    return lines;
}

function inlineTarget(context, comment) {
    if (context.provider === "gitlab") {
        const file = context.files.find((item) => [item.new_path, item.old_path].includes(comment.path));
        return file && { file };
    }
    const file = context.files.find((item) => item.filename === comment.path);
    return file && { file };
}

function validateReviewComments(context, comments) {
    if (comments.some((comment) => comment.kind !== "inline"))
        throw new ValidationError("Code reviews require inline comments anchored to changed lines.");
    for (const comment of comments) {
        const target = inlineTarget(context, comment);
        const side = comment.side || "RIGHT";
        const lines = changedLines(target?.file.diff || target?.file.patch);
        if (!target || !lines?.[side]?.has(comment.line))
            throw new ValidationError(
                `Inline comment ${comment.path}:${comment.line} must belong to the changed diff on the ${side} side.`,
            );
    }
}

function replyThreadIsOpen(context, comment) {
    if (context.provider === "gitlab") {
        const discussion = (context.discussions || []).find((item) => item.id === comment.discussionId);
        return Boolean(discussion && !discussion.resolved && !discussion.notes?.some((note) => note.resolved));
    }
    const thread = (context.discussions?.reviewThreads || []).find((item) =>
        (item.comments?.nodes || item.comments || []).some((reply) => reply.databaseId === comment.commentId),
    );
    return Boolean(thread && !thread.isResolved);
}

function assertNoResolvedThreadReplies(context, comments) {
    if (comments.some((comment) => comment.kind === "reply" && !replyThreadIsOpen(context, comment))) {
        throw new ValidationError("Replies and corrections require an open discussion thread.");
    }
}

function commentLabel(comment) {
    if (comment.kind === "reply") return `Resposta à thread \`${comment.discussionId || comment.commentId}\``;
    if (comment.kind === "inline") return `Comentário em \`${comment.path}:${comment.line}\``;
    return "Comentário geral";
}

function formatComments(comments) {
    return comments
        .map((comment, index) => `### ${index + 1}. ${commentLabel(comment)}\n\n${comment.body.trim()}`)
        .join("\n\n");
}

function codeFence(content) {
    const longestBacktickRun = Math.max(0, ...(content?.match(/`+/g) || []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
    return `${fence}\n${content || ""}\n${fence}`;
}

function formatCorrection(correction) {
    return correction.files
        .map((file) => {
            const operation = file.operation || "update";
            if (operation === "delete") return `### \`${file.path}\` (${operation})`;
            return `### \`${file.path}\` (${operation})\n\n${codeFence(file.content)}`;
        })
        .join("\n\n");
}

function commitSha(commit) {
    return commit.object?.sha || commit.sha || commit.id;
}

function repliesWithCommitReference(replies, commit) {
    const sha = commitSha(commit);
    if (!sha) throw new ValidationError("The correction commit did not return a SHA for the thread reply.");
    return replies.map((reply) => ({
        ...reply,
        body: `${reply.body.trim()}\n\nCorrigido no commit \`${sha}\`.`,
    }));
}

export class ReviewService {
    constructor({ connections, environment = process.env, clients = {}, actions = new PendingActions() }) {
        this.connections = connections;
        this.environment = environment;
        this.clients = clients;
        this.actions = actions;
    }

    clientFor(connection) {
        if (this.clients[connection.id]) return this.clients[connection.id];
        return connection.provider === "gitlab" ? new GitLabClient(connection) : new GitHubClient(connection);
    }

    resolve(connectionId, repository) {
        const connection = resolveConnection(this.connections, connectionId, repository, this.environment);
        return { connection, client: this.clientFor(connection) };
    }

    async loadContext({ connectionId, repository, number }) {
        const { connection, client } = this.resolve(connectionId, repository);
        const context = await client.getContext(repository, number);
        const reviewSkill = detectReviewSkill(context);
        return {
            ...context,
            connectionId: connection.id,
            reviewSkill,
            reviewAllowed: Boolean(reviewSkill),
            instruction: reviewSkill
                ? `Apply the ${reviewSkill} skill before drafting findings.`
                : "No supported code-review skill was detected. Do not review or publish comments.",
        };
    }

    async previewReview({ connectionId, repository, number, comments }) {
        validateComments(comments);
        const context = await this.loadContext({ connectionId, repository, number });
        if (!context.reviewAllowed)
            throw new ValidationError(
                "Review is blocked because no supported code-review skill applies to this change.",
            );
        validateReviewComments(context, comments);
        assertNoResolvedThreadReplies(context, comments);
        const action = this.actions.create({
            type: "comments",
            connectionId,
            repository,
            number,
            expectedHeadSha: context.headSha,
            payload: { comments, context },
        });
        return preview(action, context, { comments, previewType: "comments", requiredSkill: context.reviewSkill });
    }

    async previewReviewerResponse({ connectionId, repository, number, comments }) {
        validateComments(comments);
        const { client } = this.resolve(connectionId, repository);
        const context = await this.loadContext({ connectionId, repository, number });
        await this.assertAuthor(context, client);
        assertNoResolvedThreadReplies(context, comments);
        const action = this.actions.create({
            type: "comments",
            connectionId,
            repository,
            number,
            expectedHeadSha: context.headSha,
            payload: { comments, context },
        });
        return preview(action, context, { comments, previewType: "responses", requiredSkill: context.reviewSkill });
    }

    async previewCorrection({ connectionId, repository, number, correction, replies = [] }) {
        if (!correction?.commitMessage?.trim() || !Array.isArray(correction.files) || correction.files.length === 0)
            throw new ValidationError("Correction requires a commit message and at least one file.");
        validateComments(replies);
        const { client } = this.resolve(connectionId, repository);
        const context = await this.loadContext({ connectionId, repository, number });
        await this.assertAuthor(context, client);
        if (!context.reviewAllowed)
            throw new ValidationError(
                "Correction is blocked because no supported code-review skill applies to this change.",
            );
        assertNoResolvedThreadReplies(context, replies);
        const action = this.actions.create({
            type: "correction",
            connectionId,
            repository,
            number,
            expectedHeadSha: context.headSha,
            payload: { correction, replies, context },
        });
        return preview(action, context, {
            correction,
            replies,
            previewType: "correction",
            requiredSkill: context.reviewSkill,
        });
    }

    async execute({ actionId, confirmedByUser }) {
        const action = this.actions.consume(actionId, { confirmedByUser });
        const { client } = this.resolve(action.connectionId, action.repository);
        const current = await client.getContext(action.repository, action.number);
        if (current.headSha !== action.expectedHeadSha)
            throw new ValidationError(
                "The change request was updated since the preview. Create a new preview before publishing.",
            );
        if (action.type === "comments") {
            assertNoResolvedThreadReplies(current, action.payload.comments);
            return { published: await client.publishComments(action.payload.context, action.payload.comments) };
        }
        assertNoResolvedThreadReplies(current, action.payload.replies);
        const commit = await client.commitCorrection(action.payload.context, action.payload.correction);
        const replies = repliesWithCommitReference(action.payload.replies, commit);
        const publishedReplies = await client.publishComments(
            { ...action.payload.context, headSha: commitSha(commit) || action.payload.context.headSha },
            replies,
        );
        return { commit, replies: publishedReplies };
    }

    async assertAuthor(context, client) {
        const username = await client.getCurrentUsername();
        if (!username || username !== context.author)
            throw new ValidationError(
                "This workflow is restricted to a change request authored by the authenticated user.",
            );
    }
}

function preview(action, context, details) {
    const expiresAt = new Date(action.expiresAt).toISOString();
    const publicationRequired =
        "Ask the user for explicit confirmation in this Codex conversation, then call code_review_execute with confirmedByUser: true.";
    return {
        actionId: action.actionId,
        expiresAt,
        provider: context.provider,
        repository: context.repository,
        number: context.number,
        expectedHeadSha: context.headSha,
        ...details,
        publicationRequired,
        previewMarkdown: formatPreviewMarkdown(context, details, action.actionId, expiresAt),
    };
}

function formatPreviewMarkdown(context, details, actionId, expiresAt) {
    const correctionPreview = Boolean(details.correction);
    const responsePreview = details.previewType === "responses";
    const sections = [
        `# Prévia ${correctionPreview ? "da correção" : responsePreview ? "das respostas" : "dos comentários"}`,
        `**Destino:** ${context.provider} · \`${context.repository}\` · #${context.number}`,
    ];
    if (correctionPreview) {
        sections.push(
            `## Commit\n\n\`${details.correction.commitMessage}\``,
            `## Arquivos que serão alterados\n\n${formatCorrection(details.correction)}`,
        );
        if (details.replies?.length)
            sections.push(`## Respostas que serão enviadas\n\n${formatComments(details.replies)}`);
    } else {
        sections.push(
            `## ${responsePreview ? "Respostas" : "Comentários"} que serão enviados\n\n${formatComments(details.comments)}`,
        );
    }
    sections.push(
        `## Confirmação necessária\n\nRevise o conteúdo acima. Para autorizar o envio, confirme explicitamente nesta conversa.\n\n- **actionId:** \`${actionId}\`\n- **Expira em:** ${expiresAt}`,
    );
    return sections.join("\n\n");
}
