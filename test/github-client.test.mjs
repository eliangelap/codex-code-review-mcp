import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../src/github-client.mjs";

function response(payload) {
    return { ok: true, text: async () => JSON.stringify(payload) };
}

test("loads GitHub review-thread resolution state", async () => {
    const calls = [];
    const client = new GitHubClient(
        { baseUrl: "https://github.example.com/api/v3", token: "secret" },
        {
            fetchImplementation: async (url, options) => {
                calls.push({ url, options });
                if (url === "https://github.example.com/api/graphql") {
                    return response({
                        data: {
                            repository: {
                                pullRequest: {
                                    reviewThreads: {
                                        nodes: [{ isResolved: true, comments: { nodes: [{ databaseId: 42 }] } }],
                                    },
                                },
                            },
                        },
                    });
                }
                if (url.endsWith("/files?per_page=100")) return response([]);
                if (url.endsWith("/comments?per_page=100")) return response([]);
                if (url.endsWith("/issues/3/comments?per_page=100")) return response([]);
                return response({
                    title: "Change",
                    user: { login: "dev" },
                    head: { ref: "feature/change", sha: "head" },
                    base: { sha: "base" },
                });
            },
        },
    );

    const context = await client.getContext("acme/web", 3);

    assert.deepEqual(context.discussions.reviewThreads, [
        { isResolved: true, comments: { nodes: [{ databaseId: 42 }] } },
    ]);
    assert.equal(calls.find((call) => call.url === "https://github.example.com/api/graphql").options.method, "POST");
});
