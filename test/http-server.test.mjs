import assert from "node:assert/strict";
import test from "node:test";
import { createHttpServer } from "../src/http-server.mjs";

async function withServer(callback) {
    const calls = [];
    const service = {
        listRepositories: async (connectionId) => ({ connectionId, provider: "github", repositories: ["acme/web"] }),
        listChangeRequests: async ({ connectionId, repository }) => ({ connectionId, provider: "github", changeRequests: [{ number: 7, title: repository }] }),
        loadContext: async (input) => {
            calls.push(["context", input]);
            return { repository: input.repository, number: input.number };
        },
        previewReview: async (input) => ({ actionId: "review-1", comments: input.comments }),
        previewReviewerResponse: async () => ({ actionId: "response-1" }),
        previewCorrection: async () => ({ actionId: "correction-1" }),
        execute: async (input) => ({ published: input.actionId }),
    };
    const server = createHttpServer({
        connections: [{ id: "github", provider: "github", baseUrl: "https://api.github.com", allowedRepositories: ["acme/web"] }],
        service,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        await callback(server.address().port, calls);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
}

test("exposes safe connection details and delegates context loading", async () => {
    await withServer(async (port, calls) => {
        const connections = await fetch(`http://127.0.0.1:${port}/api/connections`).then((response) => response.json());
        assert.deepEqual(connections, [{ id: "github", provider: "github", baseUrl: "https://api.github.com", allowedRepositories: ["acme/web"] }]);

        const context = await fetch(`http://127.0.0.1:${port}/api/context`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ connectionId: "github", repository: "acme/web", number: 7 }),
        }).then((response) => response.json());
        assert.deepEqual(context, { repository: "acme/web", number: 7 });
        assert.deepEqual(calls, [["context", { connectionId: "github", repository: "acme/web", number: 7 }]]);
    });
});

test("requires explicit confirmation for execution", async () => {
    await withServer(async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ actionId: "review-1", confirmedByUser: false }),
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /confirmation/i);
    });
});

test("lists repositories for a connection", async () => {
    await withServer(async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/repositories?connectionId=github`);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            connectionId: "github",
            provider: "github",
            repositories: ["acme/web"],
        });
    });
});

test("lists open change requests for a repository", async () => {
    await withServer(async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/change-requests?connectionId=github&repository=acme%2Fweb`);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            connectionId: "github",
            provider: "github",
            changeRequests: [{ number: 7, title: "acme/web" }],
        });
    });
});
