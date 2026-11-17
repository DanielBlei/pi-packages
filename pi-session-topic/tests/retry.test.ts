import assert from "node:assert/strict"
import test from "node:test"
import { canAttempt } from "../extensions/title.ts"

test("a session stops retrying after 5 transient failures", () => {
	assert.equal(canAttempt({ attempts: 0, transientFailures: 4 }), true)
	assert.equal(canAttempt({ attempts: 0, transientFailures: 5 }), false)
})

test("a deterministic failure still counts toward 2", () => {
	assert.equal(canAttempt({ attempts: 1, transientFailures: 0 }), true)
	assert.equal(canAttempt({ attempts: 2, transientFailures: 0 }), false)
})
