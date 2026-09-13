import test from "node:test";
import assert from "node:assert/strict";
import { resolveConnection, validateConnection } from "../src/config.mjs";
import { AuthorizationError, ConfigurationError } from "../src/errors.mjs";

const connection = validateConnection({
    id: "github",
    provider: "github",
    baseUrl: "https://api.github.com",
    tokenEnv: "TOKEN",
    allowedRepositories: ["acme/web"],
});

test("resolves only allowlisted repositories and injects the token", () => {
    const result = resolveConnection([connection], "github", "acme/web", { TOKEN: "secret" });
    assert.equal(result.token, "secret");
    assert.equal(result.baseUrl, "https://api.github.com");
});

test("resolves GitHub repositories covered by an owner wildcard", () => {
    const wildcardConnection = validateConnection({
        ...connection,
        allowedRepositories: ["acme/*"],
    });

    const result = resolveConnection([wildcardConnection], "github", "acme/web", { TOKEN: "secret" });

    assert.equal(result.token, "secret");
});

test("does not resolve repositories outside an owner wildcard", () => {
    const wildcardConnection = validateConnection({
        ...connection,
        allowedRepositories: ["acme/*"],
    });

    for (const repository of ["acme-extra/web", "other/web", "acme/group/web"]) {
        assert.throws(
            () => resolveConnection([wildcardConnection], "github", repository, { TOKEN: "secret" }),
            AuthorizationError,
        );
    }
});

test("rejects missing token and repositories outside the allowlist", () => {
    assert.throws(() => resolveConnection([connection], "github", "acme/web", {}), AuthorizationError);
    assert.throws(
        () => resolveConnection([connection], "github", "acme/other", { TOKEN: "secret" }),
        AuthorizationError,
    );
});

test("rejects duplicate and malformed connection configuration", () => {
    assert.throws(() => validateConnection({ ...connection, id: "github" }, new Set(["github"])), ConfigurationError);
    assert.throws(() => validateConnection({ ...connection, baseUrl: "invalid" }), ConfigurationError);
});

test("rejects unsupported wildcard patterns", () => {
    for (const allowedRepository of ["*", "*/web", "acme/web*", "acme/*/web"]) {
        assert.throws(
            () => validateConnection({ ...connection, allowedRepositories: [allowedRepository] }),
            ConfigurationError,
        );
    }

    assert.throws(
        () => validateConnection({ ...connection, provider: "gitlab", allowedRepositories: ["acme/*"] }),
        ConfigurationError,
    );
});
