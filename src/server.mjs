#!/usr/bin/env node
import readline from "node:readline";
import { loadConnections } from "./config.mjs";
import { ReviewService } from "./review-service.mjs";

const connections = await loadConnections();
const service = new ReviewService({ connections });

const tools = [
    tool(
        "code_review_list_connections",
        "Lists configured connections without revealing tokens.",
        { type: "object", properties: {}, additionalProperties: false },
        true,
    ),
    tool(
        "code_review_list_repositories",
        "Lists visible GitHub repositories or GitLab repositories allowed by the connection configuration.",
        object({ connectionId: string() }, ["connectionId"]),
        true,
    ),
    tool(
        "code_review_load_context",
        "Loads a GitLab MR or GitHub PR, its source and target branches, and the mandatory review instructions.",
        targetSchema(),
        true,
    ),
    tool(
        "code_review_preview_review",
        "Previews review comments: inline comments must target changed lines; general comments are for findings outside the diff. Never publishes.",
        commentsSchema(),
        true,
    ),
    tool(
        "code_review_preview_response",
        "Previews responses to reviewer observations. Never publishes.",
        commentsSchema(),
        true,
    ),
    tool(
        "code_review_preview_correction",
        "Previews a correction commit and replies. Never publishes.",
        correctionSchema(),
        true,
    ),
    tool(
        "code_review_execute",
        "Publishes exactly one approved preview. Requires explicit user confirmation.",
        object({ actionId: string(), confirmedByUser: { type: "boolean", const: true } }, [
            "actionId",
            "confirmedByUser",
        ]),
        false,
    ),
];

function string(description) {
    return { type: "string", ...(description ? { description } : {}) };
}
function object(properties, required) {
    return { type: "object", properties, required, additionalProperties: false };
}
function tool(name, description, inputSchema, readOnlyHint) {
    return { name, description, inputSchema, annotations: { readOnlyHint, destructiveHint: !readOnlyHint } };
}
function targetSchema(extra = {}) {
    return object(
        {
            connectionId: string(),
            repository: string("GitLab group/project or GitHub owner/repository."),
            number: { type: "integer", minimum: 1 },
            ...extra,
        },
        ["connectionId", "repository", "number", ...Object.keys(extra)],
    );
}
function commentsSchema() {
    return targetSchema({
        comments: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ["inline", "general", "reply"] },
                    body: string(),
                    path: string("Required for inline comments; changed file path."),
                    line: { type: "integer", minimum: 1, description: "Required for inline comments; changed line." },
                    side: { type: "string", enum: ["LEFT", "RIGHT"] },
                    discussionId: string(),
                    commentId: { type: "integer", minimum: 1 },
                },
                required: ["kind", "body"],
                additionalProperties: false,
            },
        },
    });
}
function correctionSchema() {
    return targetSchema({
        correction: {
            type: "object",
            properties: {
                commitMessage: string(),
                files: {
                    type: "array",
                    minItems: 1,
                    items: {
                        type: "object",
                        properties: {
                            path: string(),
                            content: string(),
                            operation: { type: "string", enum: ["create", "update", "delete"] },
                        },
                        required: ["path"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["commitMessage", "files"],
            additionalProperties: false,
        },
        replies: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ["inline", "general", "reply"] },
                    body: string(),
                    discussionId: string(),
                    commentId: { type: "integer", minimum: 1 },
                },
                required: ["kind", "body"],
                additionalProperties: false,
            },
        },
    });
}

async function execute(name, input) {
    switch (name) {
        case "code_review_list_connections":
            return connections.map(({ id, provider, baseUrl, allowedRepositories, tokenEnv }) => ({
                id,
                provider,
                baseUrl,
                allowedRepositories,
                tokenEnv,
            }));
        case "code_review_list_repositories":
            return service.listRepositories(input.connectionId);
        case "code_review_load_context":
            return service.loadContext(input);
        case "code_review_preview_review":
            return service.previewReview(input);
        case "code_review_preview_response":
            return service.previewReviewerResponse(input);
        case "code_review_preview_correction":
            return service.previewCorrection(input);
        case "code_review_execute":
            return service.execute(input);
        default:
            throw new Error(`Unknown tool ${name}.`);
    }
}

function respond(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function fail(id, error) {
    process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: error.message } })}\n`,
    );
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
    let request;
    try {
        request = JSON.parse(line);
        if (request.method === "initialize")
            respond(request.id, {
                protocolVersion: request.params?.protocolVersion || "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "codex-code-review", version: "0.1.0" },
                instructions:
                    `For every code review, apply the instructions from the available applicable code-review skills.
                    If the project directory is not available in the current Codex workspace, clone the repository with git clone before reviewing.
                    Compare the merge-request or pull-request source branch with its target branch.
                    Findings in changed code must be prepared as inline comments anchored to the corresponding changed line;
                    findings in unchanged code must be prepared as general comments on the merge request or pull request.
                    For each unresolved merge-request or pull-request review thread, assess whether the observation is technically valid.
                    Before preparing any correction or thread reply, create a correction plan and a separate reply plan, then present both plans to the user for approval.
                    If the observation is valid, after plan approval prepare a correction commit and a reply to that same thread;
                    after explicit user confirmation of the preview, publish the correction first and reply with the resulting commit SHA.
                    If it is not valid, after plan approval prepare a technically justified reply to that same thread.
                    Never call a write tool without explicit confirmation from the user in this conversation.`,
            });
        else if (request.method === "tools/list") respond(request.id, { tools });
        else if (request.method === "tools/call") {
            const result = await execute(request.params.name, request.params.arguments || {});
            respond(request.id, {
                content: [{ type: "text", text: result.previewMarkdown || JSON.stringify(result, null, 2) }],
                structuredContent: result,
            });
        } else if (request.id !== undefined) respond(request.id, {});
    } catch (error) {
        fail(request?.id, error);
    }
});

export { execute, tools };
