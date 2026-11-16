// Title logic for pi-session-topic.
//
// Pure helpers (width, clipping, prompt, normalization) plus the
// generate-and-apply flow with injected dependencies, so the tests can drive
// every guard without a pi runtime or a provider.

/** Default budget for a title, in terminal cells (see displayWidth). */
export const DEFAULT_MAX_WIDTH = 48

/** Long first prompts keep their beginning and end; the middle is dropped. */
const HEAD_CHARS = 600
const TAIL_CHARS = 2400

const TRUNCATION_MARK = "\n[... clipped ...]\n"

/** Leading labels some models add despite the instruction not to. */
const LABEL_PATTERN = /^(?:session\s+)?(?:title|name|topic|标题|名称|主题)\s*[:：\-]\s*/i

/** Characters that never survive as real title content. */
const EDGE_PATTERN = /^[\s"'`*_#>~\-–—•]+|[\s"'`*_#>~\-–—•]+$/g

/** Trailing sentence punctuation that a title does not need. */
const TRAILING_PUNCTUATION = /[.:：。!！?？,，;；]+$/

/**
 * Width of a string in terminal cells. CJK and fullwidth glyphs take two
 * cells, so a title budget measured in cells keeps titles readable in the
 * session selector for Chinese, Japanese and Korean prompts too.
 */
export function displayWidth(text: string): number {
	let width = 0
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0
		width += isWide(code) ? 2 : 1
	}
	return width
}

function isWide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
		(code >= 0x2e80 && code <= 0x303e) || // CJK radicals, Kangxi, punctuation
		(code >= 0x3041 && code <= 0x33ff) || // Kana, CJK compatibility
		(code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
		(code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
		(code >= 0xa000 && code <= 0xa4cf) || // Yi
		(code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
		(code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
		(code >= 0xfe30 && code <= 0xfe6f) || // CJK compatibility forms
		(code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f64f) || // Emoji
		(code >= 0x1f900 && code <= 0x1f9ff) ||
		(code >= 0x20000 && code <= 0x3fffd) // CJK extension B and later
	)
}

/**
 * Keep a long first prompt small enough to send: head and tail carry the
 * request, the middle is usually pasted context.
 */
export function clipPrompt(prompt: string, head = HEAD_CHARS, tail = TAIL_CHARS): string {
	if (prompt.length <= head + tail) return prompt
	return prompt.slice(0, head) + TRUNCATION_MARK + prompt.slice(prompt.length - tail)
}

/**
 * Turn a raw model reply into a session name. Returns "" when nothing usable
 * is left, which the caller treats as a failed attempt.
 */
export function normalizeTitle(raw: string, maxWidth = DEFAULT_MAX_WIDTH): string {
	const firstContentLine = raw
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.replace(EDGE_PATTERN, "").length > 0)
	if (!firstContentLine) return ""

	let title = firstContentLine.replace(EDGE_PATTERN, "").replace(LABEL_PATTERN, "").trim()
	title = title.replace(EDGE_PATTERN, "").replace(/\s+/g, " ").replace(TRAILING_PUNCTUATION, "").trim()
	if (!title) return ""

	if (displayWidth(title) > maxWidth) title = clipToWidth(title, maxWidth)
	title = title.replace(TRAILING_PUNCTUATION, "").trim()
	return displayWidth(title) < 2 ? "" : title
}

/** Cut at a word boundary when one exists inside the budget, else mid-word. */
function clipToWidth(text: string, maxWidth: number): string {
	let width = 0
	let cut = text.length
	let offset = 0
	// Iterate by code point so a surrogate pair is never split.
	for (const char of text) {
		width += displayWidth(char)
		if (width > maxWidth) {
			cut = offset
			break
		}
		offset += char.length
	}
	const candidate = text.slice(0, cut)
	const lastSpace = candidate.lastIndexOf(" ")
	// Only honour a word boundary when it keeps most of the budget.
	return lastSpace > candidate.length / 2 ? candidate.slice(0, lastSpace) : candidate
}

/** The instruction and the clipped prompt sent to the title model. */
export function buildTopicRequest(prompt: string): { systemPrompt: string; userText: string } {
	return {
		systemPrompt:
			"Name coding-agent sessions. Reply with the title only: 3 to 8 words, no quotes, " +
			"no markdown, no trailing period, no 'Title:' prefix. Use the language of the message. " +
			"Name the work, not the message wording.",
		userText:
			"Title this session from the user's first message. " +
			"A long message is clipped in the middle.\n\n<message>\n" +
			clipPrompt(prompt) +
			"\n</message>",
	}
}

/** Text parts of an assistant message, joined. */
export function assistantText(message: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return message.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim()
}

export type ApplyOutcome = "applied" | "kept-manual" | "switched" | "empty"

export interface ApplyDeps {
	/** Session identity captured when the request started. */
	sessionId: string
	/** Live session identity; a switch means this late result must be dropped. */
	currentSessionId(): string
	getSessionName(): string | undefined
	setSessionName(name: string): void
	/** Ask the model for a title; rejects on transport or provider errors. */
	completeQuestion(firstPrompt: string): Promise<string>
	maxWidth?: number
	/** `/topic` regeneration: an existing name may be replaced. */
	force?: boolean
}

/**
 * Generate a title and apply it, unless a name appeared meanwhile. Every check
 * runs again at write time, so a manual `/name`, a session switch, or another
 * request can never be overwritten by a late reply.
 *
 * `force` is for `/topic`: the user asked for regeneration, so an existing name
 * is replaced. The session-switch check still applies.
 */
export async function generateAndApply(firstPrompt: string, deps: ApplyDeps): Promise<ApplyOutcome> {
	if (!deps.force && deps.getSessionName()?.trim()) return "kept-manual"

	const raw = await deps.completeQuestion(firstPrompt)
	const title = normalizeTitle(raw, deps.maxWidth ?? DEFAULT_MAX_WIDTH)

	if (deps.currentSessionId() !== deps.sessionId) return "switched"
	if (!deps.force && deps.getSessionName()?.trim()) return "kept-manual"
	if (!title) return "empty"

	deps.setSessionName(title)
	return "applied"
}
