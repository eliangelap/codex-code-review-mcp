import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConnections } from "./config.mjs";
import { AuthorizationError, ConfigurationError, NotFoundError, ValidationError } from "./errors.mjs";
import { ReviewService } from "./review-service.mjs";

const MAX_BODY_BYTES = 1_000_000;
const CORS_HEADERS = {
    "access-control-allow-origin": "http://localhost:5599",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8",
};

function publicConnections(connections) {
    return connections.map(({ id, provider, baseUrl, allowedRepositories }) => ({ id, provider, baseUrl, allowedRepositories }));
}

function send(response, status, payload) {
    response.writeHead(status, CORS_HEADERS);
    response.end(JSON.stringify(payload));
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
            if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
                request.destroy(new ValidationError("Request body is too large."));
            }
        });
        request.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new ValidationError("Request body must contain valid JSON."));
            }
        });
        request.on("error", reject);
    });
}

function statusFor(error) {
    if (error instanceof AuthorizationError) return 403;
    if (error instanceof NotFoundError) return 404;
    if (error instanceof ValidationError || error instanceof ConfigurationError) return 400;
    return 500;
}

function endpointFor(pathname, service) {
    return {
        "/api/context": service.loadContext.bind(service),
        "/api/preview/review": service.previewReview.bind(service),
        "/api/preview/response": service.previewReviewerResponse.bind(service),
        "/api/preview/correction": service.previewCorrection.bind(service),
    }[pathname];
}

export function createHttpServer({ connections, service }) {
    return createServer(async (request, response) => {
        try {
            const url = new URL(request.url || "/", "http://127.0.0.1");
            if (request.method === "OPTIONS") return send(response, 204, {});
            if (request.method === "GET" && url.pathname === "/api/health") return send(response, 200, { status: "ok" });
            if (request.method === "GET" && url.pathname === "/api/connections")
                return send(response, 200, publicConnections(connections));
            if (request.method === "GET" && url.pathname === "/api/repositories") {
                const connectionId = url.searchParams.get("connectionId");
                if (!connectionId) throw new ValidationError("connectionId is required.");
                return send(response, 200, await service.listRepositories(connectionId));
            }
            if (request.method === "GET" && url.pathname === "/api/change-requests") {
                const connectionId = url.searchParams.get("connectionId");
                const repository = url.searchParams.get("repository");
                if (!connectionId || !repository) throw new ValidationError("connectionId and repository are required.");
                return send(response, 200, await service.listChangeRequests({ connectionId, repository }));
            }
            if (request.method !== "POST") return send(response, 404, { error: "Endpoint not found." });

            const input = await readJson(request);
            if (url.pathname === "/api/execute") {
                if (input.confirmedByUser !== true)
                    throw new ValidationError("Explicit confirmation is required before publication.");
                return send(response, 200, await service.execute(input));
            }
            const endpoint = endpointFor(url.pathname, service);
            if (!endpoint) return send(response, 404, { error: "Endpoint not found." });
            return send(response, 200, await endpoint(input));
        } catch (error) {
            return send(response, statusFor(error), {
                error: error instanceof Error ? error.message : "Unexpected server error.",
            });
        }
    });
}

async function start() {
    const connections = await loadConnections();
    const service = new ReviewService({ connections });
    const server = createHttpServer({ connections, service });
    server.listen(9898, "127.0.0.1", () => {
        process.stdout.write("Code review API listening at http://localhost:9898\n");
    });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) start();
