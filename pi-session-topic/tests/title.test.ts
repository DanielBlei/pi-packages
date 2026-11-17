import assert from "node:assert/strict"
import test from "node:test"
import {
	assistantText,
	buildTopicRequest,
	clipPrompt,
	displayWidth,
	generateAndApply,
	normalizeTitle,
	type ApplyDeps,
} from "../extensions/title.ts"

test("displayWidth: ascii counts one cell, CJK counts two", () => {
	assert.equal(displayWidth("abc"), 3)
	assert.equal(displayWidth("修复登录"), 8)
	assert.equal(displayWidth("a修b"), 4)
})

test("normalizeTitle: strips quotes, labels, markdown and the trailing period", () => {
	assert.equal(normalizeTitle('"Fix CI pipeline."'), "Fix CI pipeline")
	assert.equal(normalizeTitle("Title: **Refactor auth module**"), "Refactor auth module")
	assert.equal(normalizeTitle("## Add OAuth support"), "Add OAuth support")
	assert.equal(normalizeTitle("标题：修复登录模块"), "修复登录模块")
	assert.equal(normalizeTitle("`debug flaky test`"), "debug flaky test")
})

test("normalizeTitle: keeps the first content line only", () => {
	assert.equal(normalizeTitle("\n\n  Name: Speed up test suite  \n\nbecause reasons\n"), "Speed up test suite")
})

test("normalizeTitle: returns empty text when nothing usable is left", () => {
	assert.equal(normalizeTitle(""), "")
	assert.equal(normalizeTitle("   \n\t\n  "), "")
	assert.equal(normalizeTitle('""'), "")
	assert.equal(normalizeTitle("..."), "")
})

test("normalizeTitle: clips long titles at a word boundary within the cell budget", () => {
	const title = normalizeTitle("Rework the session selector so that it shows one readable topic line", 30)
	assert.ok(displayWidth(title) <= 30, title)
	assert.ok(title.startsWith("Rework the"), title)
	assert.ok(!title.endsWith(" "), title)
})

test("normalizeTitle: clips CJK titles by cells, not characters", () => {
	const title = normalizeTitle("修复登录模块中会话选择器显示过长首条提示信息的问题", 24)
	assert.ok(displayWidth(title) <= 24, `${title} = ${displayWidth(title)} cells`)
	assert.equal(title, "修复登录模块中会话选择器")
})

test("clipPrompt: short prompts pass through unchanged", () => {
	assert.equal(clipPrompt("hello"), "hello")
})

test("clipPrompt: long prompts keep the head and the tail", () => {
	const prompt = `${"A".repeat(1000)}MIDDLE${"Z".repeat(5000)}`
	const clipped = clipPrompt(prompt, 100, 200)
	assert.ok(clipped.startsWith("A".repeat(100)))
	assert.ok(clipped.endsWith("Z".repeat(200)))
	assert.ok(clipped.includes("clipped"))
	assert.ok(!clipped.includes("MIDDLE"))
	assert.ok(clipped.length < prompt.length)
})

test("buildTopicRequest: asks for a bare title and carries the clipped prompt", () => {
	const request = buildTopicRequest(`Why does ${"x".repeat(5000)} fail?`)
	assert.match(request.systemPrompt, /title only/)
	assert.ok(request.userText.includes("<message>"))
	assert.ok(request.userText.endsWith("fail?\n</message>"))
	assert.ok(request.userText.length < 4000)
})

test("assistantText: joins text parts and ignores thinking", () => {
	const text = assistantText({
		content: [
			{ type: "thinking", text: "hmm" },
			{ type: "text", text: "Fix CI pipeline" },
		],
	})
	assert.equal(text, "Fix CI pipeline")
})

function deps(overrides: Partial<ApplyDeps> & { reply?: string } = {}): ApplyDeps & { applied: string[] } {
	const applied: string[] = []
	let name = overrides.getSessionName?.()
	const base: ApplyDeps & { applied: string[] } = {
		sessionId: "s1",
		currentSessionId: () => "s1",
		getSessionName: () => name,
		setSessionName: (value: string) => {
			name = value
			applied.push(value)
		},
		completeQuestion: async () => overrides.reply ?? "Fix CI pipeline",
		applied,
		...overrides,
	}
	// Keep the local `name` in sync when a test supplies its own accessors.
	if (overrides.getSessionName || overrides.setSessionName) {
		base.getSessionName = overrides.getSessionName ?? base.getSessionName
		base.setSessionName = overrides.setSessionName ?? base.setSessionName
	}
	return base
}

test("generateAndApply: names an unnamed session", async () => {
	const d = deps({ reply: '"Fix CI pipeline."' })
	assert.equal(await generateAndApply("help me fix CI", d), "applied")
	assert.deepEqual(d.applied, ["Fix CI pipeline"])
})

test("generateAndApply: never overwrites a manual name and never asks the model", async () => {
	let asked = false
	const d = deps({
		getSessionName: () => "my own name",
		completeQuestion: async () => {
			asked = true
			return "Generated"
		},
	})
	assert.equal(await generateAndApply("help me fix CI", d), "kept-manual")
	assert.equal(asked, false)
	assert.deepEqual(d.applied, [])
})

test("generateAndApply: drops the reply when the session switched meanwhile", async () => {
	const d = deps({ currentSessionId: () => "other-session" })
	assert.equal(await generateAndApply("help me fix CI", d), "switched")
	assert.deepEqual(d.applied, [])
})

test("generateAndApply: drops the reply when a name appeared while it was in flight", async () => {
	let name: string | undefined
	const d = deps({
		completeQuestion: async () => {
			name = "named by hand"
			return "Generated"
		},
		getSessionName: () => name,
	})
	assert.equal(await generateAndApply("help me fix CI", d), "kept-manual")
	assert.deepEqual(d.applied, [])
})

test("generateAndApply: an unusable reply names nothing", async () => {
	const d = deps({ reply: "   " })
	assert.equal(await generateAndApply("help me fix CI", d), "empty")
	assert.deepEqual(d.applied, [])
})

test("generateAndApply: force replaces an existing name, still honoring a session switch", async () => {
	const d = deps({ getSessionName: () => "old title", force: true })
	assert.equal(await generateAndApply("help me fix CI", d), "applied")

	const switched = deps({ getSessionName: () => "old title", force: true, currentSessionId: () => "other" })
	assert.equal(await generateAndApply("help me fix CI", switched), "switched")
})

test("generateAndApply: a rejecting model call surfaces to the caller", async () => {
	const d = deps({
		completeQuestion: async () => {
			throw new Error("429 rate limited")
		},
	})
	await assert.rejects(() => generateAndApply("help me fix CI", d), /429/)
})

test("normalizeTitle: clipping never leaves a lone surrogate from an emoji", () => {
	// "😀" is one code point, two code units, two cells. A budget of 3 ends
	// between its two code units when the clip counts code units.
	const title = normalizeTitle("ab😀cd", 3)
	assert.doesNotMatch(title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
	assert.equal(title, "ab")
	assert.ok(displayWidth(title) <= 3)
})

test("normalizeTitle: keeps a real leading word joined by a hyphen", () => {
	assert.equal(normalizeTitle("Topic-based routing"), "Topic-based routing")
	assert.equal(normalizeTitle("Name-mangling in the linker"), "Name-mangling in the linker")
	assert.equal(normalizeTitle("Title-case converter"), "Title-case converter")
})

test("normalizeTitle: still strips labels with a colon or a spaced dash", () => {
	assert.equal(normalizeTitle("Topic - Refactor auth"), "Refactor auth")
	assert.equal(normalizeTitle("Name - Speed up tests"), "Speed up tests")
	assert.equal(normalizeTitle("Title: Refactor auth"), "Refactor auth")
	assert.equal(normalizeTitle("Session title: Refactor auth"), "Refactor auth")
	assert.equal(normalizeTitle("主题：重构"), "重构")
})

test("normalizeTitle: clipping never splits a ZWJ emoji sequence", () => {
	// Family emoji: man, ZWJ, woman, ZWJ, girl. A budget of 5 falls inside it.
	const family = "👨‍👩‍👧"
	const title = normalizeTitle(`ab${family}cd`, 5)
	assert.equal(title, "ab")
})

test("normalizeTitle: clipping never separates a combining mark from its base", () => {
	// "é" written as e + U+0301. A budget of 9 would end after the bare "e".
	const accented = "é"
	const title = normalizeTitle(accented.repeat(30), 9)
	assert.equal(title, accented.repeat(4))
})
