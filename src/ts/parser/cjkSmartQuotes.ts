// CJK-aware replacement for markdown-it's built-in `smartquotes` core rule.
//
// markdown-it decides whether a straight quote is an opening quote, a closing
// quote, or an apostrophe by looking at the characters on both sides. When a
// quote sits between two "word" characters (`don't`, `John's`) it is treated as
// an apostrophe and never paired. That heuristic is right for English, but
// Korean (and Japanese/Chinese) attach particles and verbs directly to the
// closing quote — `'테스트'는`, `"안녕"이라고` — so the closing quote was
// never recognised and RisuAI's quote highlighting (quote1/quote2 marks)
// silently failed for those sentences.
//
// This rule is a port of markdown-it 14's smartquotes with one extra decision:
// a quote that touches a CJK character on either side is never an apostrophe,
// so it is always allowed to open or close. English contractions are untouched.

import type markdownit from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type Token from 'markdown-it/lib/token.mjs'

const QUOTE_TEST_RE = /['"]/
const QUOTE_RE = /['"]/g
const APOSTROPHE = '’' /* ’ */

function replaceAt(str: string, index: number, ch: string) {
    return str.slice(0, index) + ch + str.slice(index + 1)
}

export function isCJKChar(code: number) {
    return (
        (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
        (code >= 0x3040 && code <= 0x30ff) || // Hiragana, Katakana
        (code >= 0x3130 && code <= 0x318f) || // Hangul Compatibility Jamo
        (code >= 0x31f0 && code <= 0x31ff) || // Katakana Phonetic Extensions
        (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ideographs Extension A
        (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
        (code >= 0xa960 && code <= 0xa97f) || // Hangul Jamo Extended-A
        (code >= 0xac00 && code <= 0xd7ff) || // Hangul Syllables, Hangul Jamo Extended-B
        (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
        (code >= 0xff66 && code <= 0xff9f) || // Halfwidth Katakana
        (code >= 0x20000 && code <= 0x3134f)  // CJK Unified Ideographs Extension B..G
    )
}

function lastCodePoint(str: string) {
    if (!str) return 0x20
    const last = str.charCodeAt(str.length - 1)
    if (last >= 0xdc00 && last <= 0xdfff && str.length >= 2) {
        return str.codePointAt(str.length - 2) ?? last
    }
    return last
}

function processInlines(tokens: Token[], state: StateCore) {
    const { isWhiteSpace, isPunctChar, isMdAsciiPunct } = state.md.utils
    let j: number

    const stack: { token: number, pos: number, single: boolean, level: number }[] = []

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]

        const thisLevel = tokens[i].level

        for (j = stack.length - 1; j >= 0; j--) {
            if (stack[j].level <= thisLevel) { break }
        }
        stack.length = j + 1

        if (token.type !== 'text') { continue }

        let text = token.content
        let pos = 0
        let max = text.length

        OUTER:
        while (pos < max) {
            QUOTE_RE.lastIndex = pos
            const t = QUOTE_RE.exec(text)
            if (!t) { break }

            let canOpen = true
            let canClose = true
            pos = t.index + 1
            const isSingle = (t[0] === "'")

            // Find previous character,
            // default to space if it's the beginning of the line
            let lastChar = 0x20

            if (t.index - 1 >= 0) {
                lastChar = lastCodePoint(text.slice(0, t.index))
            } else {
                for (j = i - 1; j >= 0; j--) {
                    if (tokens[j].type === 'softbreak' || tokens[j].type === 'hardbreak') break // lastChar defaults to 0x20
                    if (!tokens[j].content) continue // should skip all tokens except 'text', 'html_inline' or 'code_inline'

                    lastChar = lastCodePoint(tokens[j].content)
                    break
                }
            }

            // Find next character,
            // default to space if it's the end of the line
            let nextChar = 0x20

            if (pos < max) {
                nextChar = text.codePointAt(pos) ?? 0x20
            } else {
                for (j = i + 1; j < tokens.length; j++) {
                    if (tokens[j].type === 'softbreak' || tokens[j].type === 'hardbreak') break // nextChar defaults to 0x20
                    if (!tokens[j].content) continue // should skip all tokens except 'text', 'html_inline' or 'code_inline'

                    nextChar = tokens[j].content.codePointAt(0) ?? 0x20
                    break
                }
            }

            const isLastPunctChar = isMdAsciiPunct(lastChar) || isPunctChar(String.fromCodePoint(lastChar))
            const isNextPunctChar = isMdAsciiPunct(nextChar) || isPunctChar(String.fromCodePoint(nextChar))

            const isLastWhiteSpace = isWhiteSpace(lastChar)
            const isNextWhiteSpace = isWhiteSpace(nextChar)

            if (isNextWhiteSpace) {
                canOpen = false
            } else if (isNextPunctChar) {
                if (!(isLastWhiteSpace || isLastPunctChar)) {
                    canOpen = false
                }
            }

            if (isLastWhiteSpace) {
                canClose = false
            } else if (isLastPunctChar) {
                if (!(isNextWhiteSpace || isNextPunctChar)) {
                    canClose = false
                }
            }

            if (nextChar === 0x22 /* " */ && t[0] === '"') {
                if (lastChar >= 0x30 /* 0 */ && lastChar <= 0x39 /* 9 */) {
                    // special case: 1"" - count first quote as an inch
                    canClose = canOpen = false
                }
            }

            if (canOpen && canClose) {
                // The quote is surrounded by non-space, non-punctuation characters.
                //
                // Upstream treats this as "middle of a word" (an apostrophe) unless
                // a punctuation character is adjacent. CJK scripts attach particles
                // directly to the closing quote (`'테스트'는`, `"안녕"이라고`) and
                // never use a mid-word apostrophe, so a quote touching a CJK
                // character is always a real quote: let the stack decide whether
                // it opens or closes.
                if (!(isCJKChar(lastChar) || isCJKChar(nextChar))) {
                    canOpen = isLastPunctChar
                    canClose = isNextPunctChar
                }
            }

            if (!canOpen && !canClose) {
                // middle of word
                if (isSingle) {
                    token.content = replaceAt(token.content, t.index, APOSTROPHE)
                }
                continue
            }

            if (canClose) {
                // this could be a closing quote, rewind the stack to get a match
                for (j = stack.length - 1; j >= 0; j--) {
                    const item = stack[j]
                    if (stack[j].level < thisLevel) { break }
                    if (item.single === isSingle && stack[j].level === thisLevel) {
                        let openQuote: string
                        let closeQuote: string
                        if (isSingle) {
                            openQuote = state.md.options.quotes[2]
                            closeQuote = state.md.options.quotes[3]
                        } else {
                            openQuote = state.md.options.quotes[0]
                            closeQuote = state.md.options.quotes[1]
                        }

                        // replace token.content *before* tokens[item.token].content,
                        // because, if they are pointing at the same token, replaceAt
                        // could mess up indices when quote length != 1
                        token.content = replaceAt(token.content, t.index, closeQuote)
                        tokens[item.token].content = replaceAt(
                            tokens[item.token].content, item.pos, openQuote)

                        pos += closeQuote.length - 1
                        if (item.token === i) { pos += openQuote.length - 1 }

                        text = token.content
                        max = text.length

                        stack.length = j
                        continue OUTER
                    }
                }
            }

            if (canOpen) {
                stack.push({
                    token: i,
                    pos: t.index,
                    single: isSingle,
                    level: thisLevel
                })
            } else if (canClose && isSingle) {
                token.content = replaceAt(token.content, t.index, APOSTROPHE)
            }
        }
    }
}

function cjkSmartQuotesRule(state: StateCore) {
    if (!state.md.options.typographer) { return }

    for (let blkIdx = state.tokens.length - 1; blkIdx >= 0; blkIdx--) {
        if (state.tokens[blkIdx].type !== 'inline' ||
            !QUOTE_TEST_RE.test(state.tokens[blkIdx].content)) {
            continue
        }

        processInlines(state.tokens[blkIdx].children ?? [], state)
    }
}

// markdown-it plugin: swaps the built-in `smartquotes` core rule for the CJK-aware one.
export function cjkSmartQuotes(md: markdownit) {
    md.core.ruler.at('smartquotes', cjkSmartQuotesRule)
}
