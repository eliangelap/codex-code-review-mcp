import { HttpClient } from "./http-client.mjs";
import { StaleChangeError, ValidationError } from "./errors.mjs";

function splitRepository(repository) {
    const [owner, repo, ...rest] = repository.split("/");
    if (!owner || !repo || rest.length)
        throw new ValidationError("GitHub repository must use owner/repository format.");
    return { owner, repo };
}

function graphqlEndpoint(baseUrl) {
    const url = new URL(baseUrl);
    return `${url.origin}${url.pathname.startsWith("/api/") ? "/api" : ""}/graphql`;
}

export class GitHubClient {
    constructor(connection, dependencies = {}) {
        this.connection = connection;
        this.http =
            dependencies.http ||
            new HttpClient({
                baseUrl: connection.baseUrl,
                token: connection.token,
                headers: { Authorization: `Bearer ${connection.token}`, "X-GitHub-Api-Version": "2022-11-28" },
                fetchImplementation: dependencies.fetchImplementation,
            });
    }

    async getContext(repository, number) {
        const { owner, repo } = splitRepository(repository);
        const base = `/repos/${owner}/${repo}`;
        const [pull, files, reviewComments, issueComments, threadState] = await Promise.all([
            this.http.request(`${base}/pulls/${number}`),
            this.http.request(`${base}/pulls/${number}/files?per_page=100`),
            this.http.request(`${base}/pulls/${number}/comments?per_page=100`),
            this.http.request(`${base}/issues/${number}/comments?per_page=100`),
            this.getReviewThreads(owner, repo, number)
                .then((reviewThreads) => ({ reviewThreads }))
                .catch((error) => ({ reviewThreads: [], reviewThreadsUnavailable: error.message })),
        ]);
        return {
            provider: "github",
            repository,
            number,
            title: pull.title,
            author: pull.user?.login,
            reviewers: pull.requested_reviewers?.map((item) => item.login) || [],
            sourceBranch: pull.head.ref,
            headSha: pull.head.sha,
            baseSha: pull.base.sha,
            files,
            discussions: { reviewComments, issueComments, ...threadState },
        };
    }

    async getReviewThreads(owner, repo, number) {
        const result = await this.http.request(graphqlEndpoint(this.connection.baseUrl), {
            method: "POST",
            body: {
                query: "query ReviewThreads($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { isResolved comments(first: 100) { nodes { databaseId } } } } } } }",
                variables: { owner, repo, number },
            },
        });
        if (result.errors?.length)
            throw new ValidationError(`Unable to load GitHub review thread state: ${result.errors[0].message}`);
        return result.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
    }

    async getCurrentUsername() {
        return (await this.http.request("/user")).login;
    }

    async publishComments(context, comments) {
        const { owner, repo } = splitRepository(context.repository);
        const base = `/repos/${owner}/${repo}`;
        return Promise.all(
            comments.map((comment) => {
                if (comment.kind === "reply")
                    return this.http.request(`${base}/pulls/${context.number}/comments/${comment.commentId}/replies`, {
                        method: "POST",
                        body: { body: comment.body },
                    });
                if (comment.kind === "general")
                    return this.http.request(`${base}/issues/${context.number}/comments`, {
                        method: "POST",
                        body: { body: comment.body },
                    });
                return this.http.request(`${base}/pulls/${context.number}/comments`, {
                    method: "POST",
                    body: {
                        body: comment.body,
                        commit_id: context.headSha,
                        path: comment.path,
                        line: comment.line,
                        side: comment.side || "RIGHT",
                        ...(comment.startLine
                            ? { start_line: comment.startLine, start_side: comment.startSide || "RIGHT" }
                            : {}),
                    },
                });
            }),
        );
    }

    async commitCorrection(context, correction) {
        const refreshed = await this.getContext(context.repository, context.number);
        if (refreshed.headSha !== context.headSha)
            throw new StaleChangeError("The pull request changed since preview. Analyze it again before committing.");
        const { owner, repo } = splitRepository(context.repository);
        const base = `/repos/${owner}/${repo}/git`;
        const baseCommit = await this.http.request(`${base}/commits/${context.headSha}`);
        const tree = await this.http.request(`${base}/trees`, {
            method: "POST",
            body: {
                base_tree: baseCommit.tree.sha,
                tree: correction.files.map((file) => ({
                    path: file.path,
                    mode: "100644",
                    type: "blob",
                    ...(file.operation === "delete" ? { sha: null } : { content: file.content }),
                })),
            },
        });
        const commit = await this.http.request(`${base}/commits`, {
            method: "POST",
            body: { message: correction.commitMessage, tree: tree.sha, parents: [context.headSha] },
        });
        return this.http.request(`${base}/refs/heads/${encodeURIComponent(context.sourceBranch)}`, {
            method: "PATCH",
            body: { sha: commit.sha, force: false },
        });
    }
}
