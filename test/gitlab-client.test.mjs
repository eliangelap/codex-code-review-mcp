import test from "node:test";
import assert from "node:assert/strict";
import { GitLabClient } from "../src/gitlab-client.mjs";

const repository = "coamo/gti/dev/agprec/app-agricultura-precisao";
const project = "coamo%2Fgti%2Fdev%2Fagprec%2Fapp-agricultura-precisao";
const expectedBaseUrl = "https://gitlab.coamo.com.br/api/v4";

function response(payload) {
    return { ok: true, text: async () => JSON.stringify(payload) };
}

function createClient(baseUrl, calls) {
    return new GitLabClient(
        { baseUrl, token: "secret" },
        {
            fetchImplementation: async (url) => {
                calls.push(url);
                if (url.endsWith("/changes")) return response({ changes: [{ new_path: "src/index.ts" }] });
                if (url.includes("/discussions?")) return response([]);
                return response({
                    title: "Change",
                    author: { username: "dev" },
                    sha: "head",
                    diff_refs: { base_sha: "base", start_sha: "start" },
                });
            },
        },
    );
}

for (const baseUrl of ["https://gitlab.coamo.com.br", "https://gitlab.coamo.com.br/api/v4"]) {
    test(`loads a GitLab MR through the versioned API from ${baseUrl}`, async () => {
        const calls = [];
        const context = await createClient(baseUrl, calls).getContext(repository, 2);

        assert.equal(context.headSha, "head");
        assert.deepEqual(
            calls.sort(),
            [
                `${expectedBaseUrl}/projects/${project}/merge_requests/2`,
                `${expectedBaseUrl}/projects/${project}/merge_requests/2/changes`,
                `${expectedBaseUrl}/projects/${project}/merge_requests/2/discussions?per_page=100`,
            ].sort(),
        );
    });
}
