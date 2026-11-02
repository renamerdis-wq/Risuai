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
// This rule is a port of markdown-it 14's smartquotes with one extra decision
// for a quote that sits between two word characters and touches a CJK
// character on at least one side:
//
//   - it may always close an open quote (`'테스트'는`, `'A'는`, `'한국어'English`)
//   - it may open a quote only when both neighbours are CJK (`테스트'옥좌'에`)
//   - otherwise it is an apostrophe, as in English (`친구's`, `맥도날드's`)
//
// A CJK-opened quote that never finds its closer is turned back into an
// apostrophe, matching what upstream would have produced. Text without CJK
// characters behaves exactly as upstream markdown-it.

import type markdownit from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type Token from 'markdown-it/lib/token.mjs'

const QUOTE_TEST_RE = /['"]/
const QUOTE_RE = /['"]/g
const APOSTROPHE = '’' /* ’ */

const CJK_RE = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u

export function isCJKChar(code: number) {
    return CJK_RE.test(String.fromCodePoint(code))
}

function replaceAt(str: string, index: number, ch: string) {
    return str.slice(0, index) + ch + str.slice(index + 1)
}

// Code point of the character that ends right before `index`, handling a
// surrogate pair without allocating a substring.
function codePointBefore(str: string, index: number) {
    const code = str.charCodeAt(index - 1)
    if ((code & 0xfc00) === 0xdc00 && index >= 2 && (str.charCodeAt(index - 2) & 0xfc00) === 0xd800) {
        return str.codePointAt(index - 2) ?? code
    }
    return code
}

type StackItem = {
    token: number
    pos: number
    single: boolean
    level: number
    // opened only because of the CJK rule; becomes an apostrophe if never closed
    cjk: boolean
}

function processInlines(tokens: Token[], state: StateCore) {
    const { isWhiteSpace, isPunctChar, isMdAsciiPunct } = state.md.utils
    let j: number

    const stack: StackItem[] = []

    // Drop stack entries from `len` on. A single quote that was only allowed to
    // open because of the CJK rule and never got closed is restored to the
    // apostrophe upstream would have produced (same length, so no index shifts).
    const truncateStack = (len: number) => {
        for (let k = stack.length - 1; k >= len; k--) {
            const item = stack[k]
            if (item.cjk && item.single) {
                tokens[item.token].content = replaceAt(tokens[item.token].content, item.pos, APOSTROPHE)
            }
        }
        stack.length = len
    }

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]

        const thisLevel = tokens[i].level

        for (j = stack.length - 1; j >= 0; j--) {
            if (stack[j].level <= thisLevel) { break }
        }
        truncateStack(j + 1)

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
                lastChar = codePointBefore(text, t.index)
            } else {
                for (j = i - 1; j >= 0; j--) {
                    if (tokens[j].type === 'softbreak' || tokens[j].type === 'hardbreak') break // lastChar defaults to 0x20
                    if (!tokens[j].content) continue // should skip all tokens except 'text', 'html_inline' or 'code_inline'

                    lastChar = codePointBefore(tokens[j].content, tokens[j].content.length)
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

            let cjkOpen = false

            if (canOpen && canClose) {
                // The quote is surrounded by non-space, non-punctuation characters.
                //
                // Upstream treats this as "middle of a word" (an apostrophe) unless
                // a punctuation character is adjacent. CJK scripts attach particles
                // directly to the closing quote (`'테스트'는`, `"안녕"이라고`), so a
                // quote touching a CJK character may always close. It may open
                // only when both neighbours are CJK (`테스트'옥좌'에`); a CJK
                // character followed by Latin (`친구's`) is still an apostrophe.
                const lastCJK = isCJKChar(lastChar)
                const nextCJK = isCJKChar(nextChar)
                if (lastCJK || nextCJK) {
                    canClose = true
                    canOpen = lastCJK && nextCJK
                    cjkOpen = canOpen
                } else {
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

                        // unmatched openers nested inside the pair are dropped;
                        // the matched opener itself (stack[j]) is simply popped
                        truncateStack(j + 1)
                        stack.length = j

                        text = token.content
                        max = text.length

                        continue OUTER
                    }
                }
            }

            if (canOpen) {
                stack.push({
                    token: i,
                    pos: t.index,
                    single: isSingle,
                    level: thisLevel,
                    cjk: cjkOpen,
                })
            } else if (canClose && isSingle) {
                token.content = replaceAt(token.content, t.index, APOSTROPHE)
            }
        }
    }

    truncateStack(0)
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
