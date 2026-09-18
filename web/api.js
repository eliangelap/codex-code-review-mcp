const API_URL = import.meta.env.VITE_API_URL || "http://localhost:9898";

async function request(path, options) {
    const response = await fetch(`${API_URL}${path}`, options);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Não foi possível concluir a operação.");
    return payload;
}

export const api = {
    connections: () => request("/api/connections"),
    repositories: (connectionId) => request(`/api/repositories?connectionId=${encodeURIComponent(connectionId)}`),
    changeRequests: ({ connectionId, repository }) => request(`/api/change-requests?connectionId=${encodeURIComponent(connectionId)}&repository=${encodeURIComponent(repository)}`),
    context: (input) => request("/api/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
    previewReview: (input) => request("/api/preview/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
    previewResponse: (input) => request("/api/preview/response", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
    previewCorrection: (input) => request("/api/preview/correction", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
    execute: (actionId) => request("/api/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId, confirmedByUser: true }) }),
};
