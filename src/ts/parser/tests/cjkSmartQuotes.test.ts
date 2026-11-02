import { describe, expect, it } from "vitest";
import markdownit from "markdown-it";
import { cjkSmartQuotes, isCJKChar } from "../cjkSmartQuotes";

// Same options as parser.svelte.ts: quotes are emitted as private-use
// placeholders which the parser later turns into <mark risu-mark="..."> tags.
const PLACEHOLDERS = "\u{E9b0}\u{E9b1}\u{E9b2}\u{E9b3}";

function makeMd(plugin: boolean) {
    const md = markdownit({
        html: true,
        breaks: true,
        linkify: false,
        typographer: true,
        quotes: PLACEHOLDERS,
    });
    md.disable(["code"]);
    if (plugin) md.use(cjkSmartQuotes);
    return md;
}

// Render and show placeholders as readable brackets:
//   «» = double quote pair (quote2), ‹› = single quote pair (quote1)
function render(md: markdownit, text: string) {
    return md
        .render(text)
        .replace(//g, "«")
        .replace(//g, "»")
        .replace(//g, "‹")
        .replace(//g, "›")
        .replace(/^<p>|<\/p>\n$/g, "");
}

const withPlugin = makeMd(true);
const upstream = makeMd(false);

describe("cjkSmartQuotes: Korean particles attached to the closing quote", () => {
    const cases: [string, string][] = [
        ["'테스트'", "‹테스트›"],
        ["'테스트'는", "‹테스트›는"],
        ["'테스트' 는", "‹테스트› 는"],
        ["'테스트'입니다.", "‹테스트›입니다."],
        ["'옥좌'에", "‹옥좌›에"],
        ['"테스트"는', "«테스트»는"],
        ['"테스트" 는', "«테스트» 는"],
        ['"안녕"이라고 말했다.', "«안녕»이라고 말했다."],
        ["그는 '옥좌'에 앉아 \"안녕\"이라고 말했다.", "그는 ‹옥좌›에 앉아 «안녕»이라고 말했다."],
        ["테스트'옥좌'에", "테스트‹옥좌›에"],
    ];

    it.each(cases)("%s", (input, expected) => {
        expect(render(withPlugin, input)).toBe(expected);
    });

    it("documents the upstream behaviour this rule fixes", () => {
        expect(render(upstream, "'테스트'는")).toBe("'테스트’는");
        expect(render(upstream, '"테스트"는')).toBe("&quot;테스트&quot;는");
        expect(render(upstream, "'테스트' 는")).toBe("‹테스트› 는");
    });
});

describe("cjkSmartQuotes: English apostrophes are still apostrophes", () => {
    const cases: [string, string][] = [
        ["don't", "don’t"],
        ["it's", "it’s"],
        ["John's", "John’s"],
        ["I don't think it's John's.", "I don’t think it’s John’s."],
        ["'quoted' and don't", "‹quoted› and don’t"],
        ["\"He said 'don't' loudly\"", "«He said ‹don’t› loudly»"],
        ["foo\"bar\"baz", "foo&quot;bar&quot;baz"],
        ["1\"\" wide", "1&quot;&quot; wide"],
    ];

    it.each(cases)("%s", (input, expected) => {
        expect(render(withPlugin, input)).toBe(expected);
        // identical to upstream markdown-it for non-CJK text
        expect(render(upstream, input)).toBe(expected);
    });
});

describe("cjkSmartQuotes: mixed-language sentences", () => {
    const cases: [string, string][] = [
        ["'한국어'English", "‹한국어›English"],
        ["'A'는", "‹A›는"],
        ["'ABC'는 영어입니다.", "‹ABC›는 영어입니다."],
        ["'한국어'English don't", "‹한국어›English don’t"],
        ["그녀는 \"I don't know\"라고 했다.", "그녀는 «I don’t know»라고 했다."],
        ["'日本語'です", "‹日本語›です"],
        ["「テスト」'テスト'と言った", "「テスト」‹テスト›と言った"],
        ["'中文'的", "‹中文›的"],
        ["'ㄅㄆㄇ'ㄈ", "‹ㄅㄆㄇ›ㄈ"],
    ];

    it.each(cases)("%s", (input, expected) => {
        expect(render(withPlugin, input)).toBe(expected);
    });

    it("CJK followed by an English possessive/contraction stays an apostrophe", () => {
        const cases: [string, string][] = [
            ["친구's book", "친구’s book"],
            ["맥도날드's 햄버거", "맥도날드’s 햄버거"],
            ["맥도날드’s 햄버거", "맥도날드’s 햄버거"],
            ["테스트 A'는", "테스트 A’는"],
        ];
        for (const [input, expected] of cases) {
            expect(render(withPlugin, input)).toBe(expected);
            expect(render(upstream, input)).toBe(expected);
        }
    });

    it("keeps working across inline markup boundaries", () => {
        expect(render(withPlugin, "'**테스트**'는")).toBe("‹<strong>테스트</strong>›는");
        expect(render(withPlugin, "*'테스트'는*")).toBe("<em>‹테스트›는</em>");
    });

    it("leaves unmatched quotes alone", () => {
        expect(render(withPlugin, "'90년대")).toBe("'90년대");
        expect(render(withPlugin, "테스트'")).toBe("테스트’");
    });

    it("a CJK-opened quote that never closes falls back to an apostrophe, like upstream", () => {
        expect(render(withPlugin, "테스트'안녕")).toBe("테스트’안녕");
        expect(render(upstream, "테스트'안녕")).toBe("테스트’안녕");
        // a CJK-opened single quote nested inside a double-quote pair is dropped
        // (and restored to an apostrophe) when the outer pair closes
        expect(render(withPlugin, "\"그는 내'꺼 야\"")).toBe("«그는 내’꺼 야»");
    });

    it("handles astral code points next to a quote", () => {
        expect(render(withPlugin, "'𠀋'는")).toBe("‹𠀋›는"); // U+2000B, CJK Ext B
        expect(render(withPlugin, "'테스트'😀")).toBe("‹테스트›😀");
        expect(render(withPlugin, "😀'테스트'는")).toBe("😀‹테스트›는");
    });
});

describe("cjkSmartQuotes: known limitation (documented, not fixed)", () => {
    // Any stack-based matcher pairs a closing candidate with the nearest open
    // quote. A stray opening quote earlier in the paragraph (e.g. the rare
    // `'90년대` abbreviation style) is therefore closed by the first CJK-flanked
    // quote that follows it, highlighting text that was not meant as a quote.
    // Upstream produced no pair at all for these inputs. We accept this
    // trade-off; the tests pin the behaviour so a change is noticed.
    it("a stray opener gets paired with the first CJK-flanked quote after it", () => {
        expect(render(withPlugin, "'90년대 그는'안녕'이라고")).toBe("‹90년대 그는›안녕’이라고");
        expect(render(upstream, "'90년대 그는'안녕'이라고")).toBe("'90년대 그는’안녕’이라고");
    });

    it("an ambiguous quote inside a quotation closes it early", () => {
        expect(render(withPlugin, "'그는 내꺼'야 라고 했다'는")).toBe("‹그는 내꺼›야 라고 했다’는");
        expect(render(upstream, "'그는 내꺼'야 라고 했다'는")).toBe("'그는 내꺼’야 라고 했다’는");
    });
});

describe("isCJKChar", () => {
    it("covers the CJK scripts", () => {
        for (const ch of ["가", "ㄱ", "ᄀ", "漢", "㐀", "𠀋", "あ", "ア", "ｱ", "ㄅ"]) {
            expect(isCJKChar(ch.codePointAt(0)!), ch).toBe(true);
        }
    });

    it("rejects non-CJK characters", () => {
        for (const ch of ["a", "Z", "1", " ", "'", ".", "é", "я", "😀", "「"]) {
            expect(isCJKChar(ch.codePointAt(0)!), ch).toBe(false);
        }
    });
});
