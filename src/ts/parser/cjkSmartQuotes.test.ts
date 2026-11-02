import { describe, expect, it } from "vitest";
import markdownit from "markdown-it";
import { cjkSmartQuotes } from "./cjkSmartQuotes";

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
    ];

    it.each(cases)("%s", (input, expected) => {
        expect(render(withPlugin, input)).toBe(expected);
    });

    it("keeps working across inline markup boundaries", () => {
        expect(render(withPlugin, "'**테스트**'는")).toBe("‹<strong>테스트</strong>›는");
        expect(render(withPlugin, "*'테스트'는*")).toBe("<em>‹테스트›는</em>");
    });

    it("leaves unmatched quotes alone", () => {
        expect(render(withPlugin, "'90년대")).toBe("'90년대");
        expect(render(withPlugin, "테스트'")).toBe("테스트’");
    });
});
