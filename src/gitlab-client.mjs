import { HttpClient, encodeRepository } from "./http-client.mjs";
import { StaleChangeError } from "./errors.mjs";

function apiBaseUrl(baseUrl) {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = path.endsWith("/api/v4") ? path : `${path}/api/v4`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}

export class GitLabClient {
    constructor(connection, dependencies = {}) {
        this.connection = connection;
        this.http =
            dependencies.http ||
            new HttpClient({
                baseUrl: apiBaseUrl(connection.baseUrl),
                token: connection.token,
                headers: { "PRIVATE-TOKEN": connection.token },
                fetchImplementation: dependencies.fetchImplementation,
            });
    }

    async getContext(repository, number) {
        const project = encodeRepository(repository);
        const [mergeRequest, changes, discussions] = await Promise.all([
            this.http.request(`/projects/${project}/merge_requests/${number}`),
            this.http.request(`/projects/${project}/merge_requests/${number}/changes`),
            this.http.request(`/projects/${project}/merge_requests/${number}/discussions?per_page=100`),
        ]);
        return {
            provider: "gitlab",
            repository,
            number,
            title: mergeRequest.title,
            author: mergeRequest.author?.username,
            reviewers: mergeRequest.reviewers?.map((item) => item.username) || [],
            sourceBranch: mergeRequest.source_branch,
            headSha: mergeRequest.sha,
            baseSha: mergeRequest.diff_refs?.base_sha,
            startSha: mergeRequest.diff_refs?.start_sha,
            files: changes.changes || [],
            discussions,
        };
    }

    async getCurrentUsername() {
        return (await this.http.request("/user")).username;
    }

    async publishComments(context, comments) {
        const project = encodeRepository(context.repository);
        return Promise.all(
            comments.map((comment) => {
                if (comment.kind === "reply")
                    return this.http.request(
                        `/projects/${project}/merge_requests/${context.number}/discussions/${encodeURIComponent(comment.discussionId)}/notes`,
                        { method: "POST", body: { body: comment.body } },
                    );
                const body = { body: comment.body };
                if (comment.position)
                    body.position = {
                        base_sha: context.baseSha,
                        start_sha: context.startSha,
                        head_sha: context.headSha,
                        ...comment.position,
                    };
                return this.http.request(`/projects/${project}/merge_requests/${context.number}/discussions`, {
                    method: "POST",
                    body,
                });
            }),
        );
    }

    async commitCorrection(context, correction) {
        const refreshed = await this.getContext(context.repository, context.number);
        if (refreshed.headSha !== context.headSha)
            throw new StaleChangeError("The merge request changed since preview. Analyze it again before committing.");
        const project = encodeRepository(context.repository);
        const actions = correction.files.map((file) => ({
            action: file.operation || "update",
            file_path: file.path,
            ...(file.operation === "delete" ? {} : { content: file.content }),
        }));
        return this.http.request(`/projects/${project}/repository/commits`, {
            method: "POST",
            body: { branch: context.sourceBranch, commit_message: correction.commitMessage, actions },
        });
    }
}
