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
                    base: { ref: "main", sha: "base" },
                });
            },
        },
    );

    const context = await client.getContext("acme/web", 3);

    assert.deepEqual(context.discussions.reviewThreads, [
        { isResolved: true, comments: { nodes: [{ databaseId: 42 }] } },
    ]);
    assert.equal(context.targetBranch, "main");
    assert.equal(calls.find((call) => call.url === "https://github.example.com/api/graphql").options.method, "POST");
});

test("lists every visible GitHub repository in alphabetical order", async () => {
    const calls = [];
    const client = new GitHubClient(
        { baseUrl: "https://api.github.com", token: "secret" },
        {
            fetchImplementation: async (url) => {
                calls.push(url);
                if (url.endsWith("page=1"))
                    return response(Array.from({ length: 100 }, (_, index) => ({ full_name: `acme/repository-${99 - index}` })));
                if (url.endsWith("page=2")) return response([{ full_name: "acme/alpha" }]);
                return response([]);
            },
        },
    );

    const repositories = await client.listRepositories();
    assert.equal(repositories[0], "acme/alpha");
    assert.equal(repositories.at(-1), "acme/repository-99");
    assert.deepEqual(calls, [
        "https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100&page=1",
        "https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100&page=2",
    ]);
});

test("lists open pull requests for a repository", async () => {
    const client = new GitHubClient(
        { baseUrl: "https://api.github.com", token: "secret" },
        {
            fetchImplementation: async (url) => {
                assert.equal(url, "https://api.github.com/repos/acme/web/pulls?state=open&per_page=100&page=1");
                return response([{ number: 7, title: "Fix login" }]);
            },
        },
    );

    assert.deepEqual(await client.listChangeRequests("acme/web"), [{ number: 7, title: "Fix login" }]);
});
