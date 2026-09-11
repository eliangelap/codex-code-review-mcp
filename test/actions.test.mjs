import test from "node:test";
import assert from "node:assert/strict";
import { PendingActions } from "../src/actions.mjs";
import { NotFoundError, StaleChangeError, ValidationError } from "../src/errors.mjs";

test("requires explicit confirmation and consumes an action once", () => {
    const actions = new PendingActions();
    const action = actions.create({
        type: "comments",
        connectionId: "github",
        repository: "acme/web",
        number: 7,
        expectedHeadSha: "abc",
        payload: {},
    });
    assert.throws(() => actions.consume(action.actionId, { confirmedByUser: false }), ValidationError);
    assert.equal(actions.consume(action.actionId, { confirmedByUser: true }).actionId, action.actionId);
    assert.throws(() => actions.consume(action.actionId, { confirmedByUser: true }), NotFoundError);
});

test("rejects expired actions", () => {
    let now = 1;
    const actions = new PendingActions({ now: () => now, ttlMs: 5 });
    const action = actions.create({
        type: "comments",
        connectionId: "github",
        repository: "acme/web",
        number: 7,
        expectedHeadSha: "abc",
        payload: {},
    });
    now = 7;
    assert.throws(() => actions.consume(action.actionId, { confirmedByUser: true }), StaleChangeError);
});
