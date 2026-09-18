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
        targetBranch: "main",
        headSha,
        baseSha: "base",
        files: paths.map((filename) => ({ filename, patch: "@@ -10,1 +10,2 @@\n old\n+new" })),
        discussions: {},
    };
}

function serviceFor(currentContext, allowedRepositories = ["acme/web"]) {
    const client = {
        listRepositories: async () => ["acme/web"],
        listChangeRequests: async () => [{ number: 3, title: "Change" }],
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

test("lists GitHub repositories visible to the configured token", async () => {
    const service = serviceFor(context(["src/index.ts"]));
    service.clients.github.listRepositories = async () => ["acme/zebra", "acme/alpha"];

    assert.deepEqual(await service.listRepositories("github"), {
        connectionId: "github",
        provider: "github",
        repositories: ["acme/alpha", "acme/zebra"],
    });
});

test("lists only the configured GitLab repositories", async () => {
    const service = new ReviewService({
        connections: [
            {
                id: "gitlab",
                provider: "gitlab",
                baseUrl: "https://gitlab.example.com",
                tokenEnv: "GITLAB_TOKEN",
                allowedRepositories: ["group/zebra", "group/alpha"],
            },
        ],
    });

    assert.deepEqual(await service.listRepositories("gitlab"), {
        connectionId: "gitlab",
        provider: "gitlab",
        repositories: ["group/alpha", "group/zebra"],
    });
});

test("lists open change requests only for an allowed repository", async () => {
    const service = serviceFor(context(["src/index.ts"]));
    service.clients.github.listChangeRequests = async () => [{ number: 8, title: "Fix login" }];

    assert.deepEqual(await service.listChangeRequests({ connectionId: "github", repository: "acme/web" }), {
        connectionId: "github",
        provider: "github",
        changeRequests: [{ number: 8, title: "Fix login" }],
    });
});

test("loads a GitHub review context through an owner wildcard", async () => {
    const service = serviceFor(context(["src/index.ts"]), ["acme/*"]);

    const result = await service.loadContext({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
    });

    assert.equal(result.repository, "acme/web");
});

test("requires the React review skill and an inline changed-line comment before publishing", async () => {
    const service = serviceFor(context(["src/@presentation/page.tsx"]));
    const preview = await service.previewReview({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
        comments: [{ kind: "inline", path: "src/@presentation/page.tsx", line: 11, body: "Finding." }],
    });
    assert.equal(preview.requiredSkill, "code-review-reactjs");
    await assert.rejects(service.execute({ actionId: preview.actionId, confirmedByUser: false }), ValidationError);
    assert.deepEqual((await service.execute({ actionId: preview.actionId, confirmedByUser: true })).published, [
        { kind: "inline", path: "src/@presentation/page.tsx", line: 11, body: "Finding." },
    ]);
});

test("blocks unsupported stacks before previewing a review", async () => {
    const service = serviceFor(context(["src/main.py"]));
    await assert.rejects(
        service.previewReview({
            connectionId: "github",
            repository: "acme/web",
            number: 3,
            comments: [{ kind: "inline", path: "src/main.py", line: 11, body: "Finding." }],
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
        comments: [{ kind: "inline", path: "src/index.ts", line: 11, body: "Finding." }],
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
        comments: [{ kind: "inline", path: "src/index.ts", line: 11, body: "Este nome pode ser mais descritivo." }],
    });
    const response = await service.previewReviewerResponse({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
        comments: [{ kind: "general", body: "Ajuste confirmado." }],
    });

    assert.match(review.previewMarkdown, /# Prévia dos comentários/);
    assert.match(review.previewMarkdown, /Comentário em `src\/index\.ts:11`/);
    assert.match(review.previewMarkdown, /Este nome pode ser mais descritivo\./);
    assert.match(response.previewMarkdown, /# Prévia das respostas/);
    assert.match(response.previewMarkdown, /Ajuste confirmado\./);
});

test("allows general comments for findings outside the diff and rejects inline lines outside it", async () => {
    const service = serviceFor(context(["src/index.ts"]));

    const preview = await service.previewReview({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
        comments: [{ kind: "general", body: "Finding outside the changed diff." }],
    });
    assert.deepEqual(preview.comments, [{ kind: "general", body: "Finding outside the changed diff." }]);
    await assert.rejects(
        service.previewReview({
            connectionId: "github",
            repository: "acme/web",
            number: 3,
            comments: [{ kind: "inline", path: "src/index.ts", line: 10, body: "Finding." }],
        }),
        /must belong to the changed diff/,
    );
});

test("instructs Codex to clone when needed and compare source and target branches", async () => {
    const service = serviceFor(context(["src/index.ts"]));

    const result = await service.loadContext({
        connectionId: "github",
        repository: "acme/web",
        number: 3,
    });

    assert.equal(result.sourceBranch, "feature/change");
    assert.equal(result.targetBranch, "main");
    assert.match(result.instruction, /git clone/i);
    assert.match(result.instruction, /feature\/change/);
    assert.match(result.instruction, /main/);
    assert.match(result.instruction, /inline/i);
    assert.match(result.instruction, /general/i);
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
