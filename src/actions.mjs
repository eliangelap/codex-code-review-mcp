import { randomUUID } from "node:crypto";
import { NotFoundError, StaleChangeError, ValidationError } from "./errors.mjs";

export class PendingActions {
    constructor({ now = Date.now, ttlMs = 30 * 60 * 1000 } = {}) {
        this.now = now;
        this.ttlMs = ttlMs;
        this.items = new Map();
    }

    create({ type, connectionId, repository, number, expectedHeadSha, payload }) {
        const actionId = randomUUID();
        this.items.set(actionId, {
            actionId,
            type,
            connectionId,
            repository,
            number,
            expectedHeadSha,
            payload,
            expiresAt: this.now() + this.ttlMs,
        });
        return this.items.get(actionId);
    }

    consume(actionId, { confirmedByUser }) {
        if (confirmedByUser !== true)
            throw new ValidationError("Explicit user confirmation is required before publication.");
        const action = this.items.get(actionId);
        if (!action) throw new NotFoundError("Unknown or already consumed actionId.");
        this.items.delete(actionId);
        if (action.expiresAt < this.now())
            throw new StaleChangeError("The preview expired. Create a new preview before publishing.");
        return action;
    }
}
