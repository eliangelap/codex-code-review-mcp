import { ValidationError } from "./errors.mjs";

export class HttpClient {
    constructor({ baseUrl, token, headers = {}, fetchImplementation = fetch }) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.token = token;
        this.headers = headers;
        this.fetch = fetchImplementation;
    }

    async request(path, { method = "GET", body } = {}) {
        const url = /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}`;
        const response = await this.fetch(url, {
            method,
            headers: {
                Accept: "application/json",
                ...this.headers,
                ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;
        if (!response.ok)
            throw new ValidationError(
                `Remote API request failed (${response.status}): ${payload?.message || payload?.error || response.statusText}`,
            );
        return payload;
    }
}

export function encodeRepository(repository) {
    if (!/^[^/\s]+\/.+/.test(repository))
        throw new ValidationError("Repository must use owner/repository or group/project format.");
    return encodeURIComponent(repository);
}
