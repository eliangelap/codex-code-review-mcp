import test from "node:test";
import assert from "node:assert/strict";
import { ReviewService } from "../src/review-service.mjs";
import { ValidationError } from "../src/errors.mjs";

function context(paths, headSha = "sha-1") {
    return {
        provider: "github",
        repository: "acme/web",
        number: 3,
        title: "Change",
        author: "dev",
        sourceBranch: "feature/change",
        headSha,
        baseSha: "base",
        files: paths.map((filename) => ({ filename })),
        discussions: {},
    };
}

function serviceFor(currentContext, allowedRepositories = ["acme/web"]) {
    const client = {
        getContext: async () => currentContext,
        getCurrentUsername: async () => "dev",
        publishComments: async (_context, comments) => comments,
        commitCorrection: async () => ({ sha: "sha-2" }),
    };
    return new ReviewService({
        connections: [
            {
                id: "github",
                provider: "github",
                baseUrl: "https://api.github.com",
                tokenEnv: "TOKEN",
                allowedRepositories,
            },
        ],
        environment: { TOKEN: "secret" },
        clients: { github: client },
    });
}

test("loads a GitHub review context through an owner wildcard", async () => {
    const service = serviceFor(context(["src/index.ts"]), ["acme/*"]);

    const result = await service.loadContext({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
    });

    assert.equal(result.repository, "acme/web");
});

test("requires the React review skill for TSX changes and publishes only after confirmation", async () => {
    const service = serviceFor(context(["src/@presentation/page.tsx"]));
    const preview = await service.previewReview({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
        comments: [{ kind: "general", body: "Finding." }],
    });
    assert.equal(preview.requiredSkill, "code-review-reactjs");
    await assert.rejects(service.execute({ actionId: preview.actionId, confirmedByUser: false }), ValidationError);
    assert.deepEqual((await service.execute({ actionId: preview.actionId, confirmedByUser: true })).published, [
        { kind: "general", body: "Finding." },
    ]);
});

test("blocks unsupported stacks before previewing a review", async () => {
    const service = serviceFor(context(["src/main.py"]));
    await assert.rejects(
        service.previewReview({
            connectionId: "github",
            repository: "acme/web",
            number: 3,
            comments: [{ kind: "general", body: "Finding." }],
        }),
        ValidationError,
    );
});

test("blocks publication when the remote head changed", async () => {
    const initial = context(["src/index.ts"]);
    const service = serviceFor(initial);
    const preview = await service.previewReview({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
        comments: [{ kind: "general", body: "Finding." }],
    });
    service.clients.github.getContext = async () => context(["src/index.ts"], "sha-2");
    await assert.rejects(service.execute({ actionId: preview.actionId, confirmedByUser: true }), ValidationError);
});

test("blocks correction previews when the authenticated account did not author the change", async () => {
    const service = serviceFor(context(["src/index.ts"]));
    service.clients.github.getCurrentUsername = async () => "another-user";
    await assert.rejects(
        service.previewCorrection({
            connectionId: "github",
            repository: "acme/web",
            number: 3,
            correction: {
                commitMessage: "fix: correct review finding",
                files: [{ path: "src/index.ts", content: "export {};" }],
            },
            replies: [{ kind: "general", body: "Prepared correction." }],
        }),
        ValidationError,
    );
});

test("formats a correction preview as readable Markdown before approval", async () => {
    const service = serviceFor(context(["src/index.ts"]));
    const preview = await service.previewCorrection({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
        correction: {
            commitMessage: "fix: correct review finding",
            files: [{ path: "src/index.ts", content: "export const answer = 42;" }],
        },
        replies: [{ kind: "general", body: "Corrigido no commit preparado." }],
    });

    assert.match(preview.previewMarkdown, /# Prévia da correção/);
    assert.match(preview.previewMarkdown, /fix: correct review finding/);
    assert.match(preview.previewMarkdown, /src\/index\.ts/);
    assert.match(preview.previewMarkdown, /Corrigido no commit preparado\./);
    assert.match(preview.previewMarkdown, /Confirmação necessária/);
});

test("publishes a correction reply after the commit with its effective SHA", async () => {
    const current = context(["src/index.ts"]);
    current.discussions = { reviewThreads: [{ isResolved: false, comments: [{ databaseId: 42 }] }] };
    const service = serviceFor(current);
    const operations = [];
    service.clients.github.commitCorrection = async () => {
        operations.push("commit");
        return { sha: "sha-2" };
    };
    service.clients.github.publishComments = async (_context, comments) => {
        operations.push("reply");
        return comments;
    };

    const preview = await service.previewCorrection({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
        correction: {
            commitMessage: "fix: correct review finding",
            files: [{ path: "src/index.ts", content: "export {};" }],
        },
        replies: [{ kind: "reply", commentId: 42, body: "Corrigido." }],
    });

    const result = await service.execute({ actionId: preview.actionId, confirmedByUser: true });

    assert.deepEqual(operations, ["commit", "reply"]);
    assert.equal(result.replies[0].body, "Corrigido.\n\nCorrigido no commit `sha-2`.");
});

test("uses the GitLab commit identifier when publishing a correction reply", async () => {
    const current = context(["src/index.ts"]);
    current.discussions = { reviewThreads: [{ isResolved: false, comments: [{ databaseId: 42 }] }] };
    const service = serviceFor(current);
    service.clients.github.commitCorrection = async () => ({ id: "gitlab-sha-2" });

    const preview = await service.previewCorrection({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
        correction: {
            commitMessage: "fix: correct review finding",
            files: [{ path: "src/index.ts", content: "export {};" }],
        },
        replies: [{ kind: "reply", commentId: 42, body: "Corrigido." }],
    });

    const result = await service.execute({ actionId: preview.actionId, confirmedByUser: true });

    assert.equal(result.replies[0].body, "Corrigido.\n\nCorrigido no commit `gitlab-sha-2`.");
});

test("formats comment and reviewer-response previews as readable Markdown before approval", async () => {
    const service = serviceFor(context(["src/index.ts"]));
    const review = await service.previewReview({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
        comments: [{ kind: "inline", path: "src/index.ts", line: 12, body: "Este nome pode ser mais descritivo." }],
    });
    const response = await service.previewReviewerResponse({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
        comments: [{ kind: "general", body: "Ajuste confirmado." }],
    });

    assert.match(review.previewMarkdown, /# Prévia dos comentários/);
    assert.match(review.previewMarkdown, /Comentário em `src\/index\.ts:12`/);
    assert.match(review.previewMarkdown, /Este nome pode ser mais descritivo\./);
    assert.match(response.previewMarkdown, /# Prévia das respostas/);
    assert.match(response.previewMarkdown, /Ajuste confirmado\./);
});

test("does not preview a correction or response for a resolved GitLab discussion", async () => {
    const resolvedDiscussion = context(["src/index.ts"]);
    resolvedDiscussion.provider = "gitlab";
    resolvedDiscussion.discussions = [{ id: "discussion-1", resolved: true }];
    const service = serviceFor(resolvedDiscussion);
    service.clients.github.getCurrentUsername = async () => "dev";

    await assert.rejects(
        service.previewReviewerResponse({
            connectionId: "github",
            repository: "acme/web",
            number: 3,
            comments: [{ kind: "reply", discussionId: "discussion-1", body: "Acknowledged." }],
        }),
        ValidationError,
    );
    await assert.rejects(
        service.previewCorrection({
            connectionId: "github",
            repository: "acme/web",
            number: 3,
            correction: {
                commitMessage: "fix: correct review finding",
                files: [{ path: "src/index.ts", content: "export {};" }],
            },
            replies: [{ kind: "reply", discussionId: "discussion-1", body: "Fixed." }],
        }),
        ValidationError,
    );
});

test("does not publish a reply when its thread was resolved after preview", async () => {
    const initial = context(["src/index.ts"]);
    initial.discussions = { reviewThreads: [{ isResolved: false, comments: [{ databaseId: 42 }] }] };
    const service = serviceFor(initial);
    const preview = await service.previewReviewerResponse({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
        comments: [{ kind: "reply", commentId: 42, body: "Acknowledged." }],
    });
    const resolved = context(["src/index.ts"]);
    resolved.discussions = { reviewThreads: [{ isResolved: true, comments: [{ databaseId: 42 }] }] };
    service.clients.github.getContext = async () => resolved;

    await assert.rejects(service.execute({ actionId: preview.actionId, confirmedByUser: true }), ValidationError);
});
