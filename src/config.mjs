import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthorizationError, ConfigurationError, ValidationError } from "./errors.mjs";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "codex-code-review-mcp", "connections.json");

export async function loadConnections({ environment = process.env, read = readFile } = {}) {
    const path = environment.CODE_REVIEW_CONNECTIONS_FILE || DEFAULT_CONFIG_PATH;
    let payload;
    try {
        payload = JSON.parse(await read(path, "utf8"));
    } catch (error) {
        throw new ConfigurationError(`Unable to load connection configuration at ${path}: ${error.message}`);
    }
    if (!Array.isArray(payload.connections) || payload.connections.length === 0) {
        throw new ConfigurationError("Connection configuration must contain a non-empty connections array.");
    }
    const ids = new Set();
    return payload.connections.map((connection) => validateConnection(connection, ids));
}

export function validateConnection(connection, ids = new Set()) {
    const required = ["id", "provider", "baseUrl", "tokenEnv", "allowedRepositories"];
    for (const key of required) if (!connection?.[key]) throw new ConfigurationError(`Connection is missing ${key}.`);
    if (!["gitlab", "github"].includes(connection.provider))
        throw new ConfigurationError(`Unsupported provider ${connection.provider}.`);
    if (ids.has(connection.id)) throw new ConfigurationError(`Duplicate connection id ${connection.id}.`);
    if (!Array.isArray(connection.allowedRepositories) || connection.allowedRepositories.length === 0) {
        throw new ConfigurationError(`Connection ${connection.id} must define allowedRepositories.`);
    }
    let baseUrl;
    try {
        baseUrl = new URL(connection.baseUrl).toString().replace(/\/$/, "");
    } catch {
        throw new ConfigurationError(`Connection ${connection.id} has an invalid baseUrl.`);
    }
    ids.add(connection.id);
    return { ...connection, baseUrl };
}

export function resolveConnection(connections, connectionId, repository, environment = process.env) {
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) throw new ValidationError(`Unknown connectionId ${connectionId}.`);
    if (!connection.allowedRepositories.includes(repository))
        throw new AuthorizationError(`Repository ${repository} is not allowed for connection ${connectionId}.`);
    const token = environment[connection.tokenEnv];
    if (!token)
        throw new AuthorizationError(
            `Missing token environment variable ${connection.tokenEnv} for connection ${connectionId}.`,
        );
    return { ...connection, token };
}
