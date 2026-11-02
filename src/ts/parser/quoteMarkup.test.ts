import { describe, expect, it, vi } from "vitest";

// parser.svelte pulls in the module system, whose startup $effect touches stores
// that are still initialising when the parser is imported directly (circular
// import). None of it is needed to render plain markdown, so stub it out like
// the other parser-adjacent tests do.
vi.mock("../process/modules", () => ({
    getModules: () => [],
    getModuleAssets: () => [],
    getModuleLorebooks: () => [],
    getModuleRegexScripts: () => [],
    getModuleTriggers: () => [],
    moduleUpdate: () => {},
}));

import { ParseMarkdown } from "./parser.svelte";

// End-to-end: the rendered chat HTML must wrap paired quotes in
// <mark risu-mark="quote1"> (single quotes) / <mark risu-mark="quote2"> (double quotes),
// including when Korean particles are attached directly to the closing quote.

const Q1 = (inner: string) => `<mark risu-mark="quote1">‘${inner}’</mark>`;
const Q2 = (inner: string) => `<mark risu-mark="quote2">“${inner}”</mark>`;

async function render(text: string) {
    const html = await ParseMarkdown(text, null, "notrim");
    return html.replace(/^<p>|<\/p>\n?$/g, "").trim();
}

describe("quote highlighting markup (quote1 / quote2)", () => {
    it("Korean sentences with particles attached to the closing quote", async () => {
        expect(await render("'테스트'")).toBe(Q1("테스트"));
        expect(await render("'테스트'는")).toBe(`${Q1("테스트")}는`);
        expect(await render("'테스트' 는")).toBe(`${Q1("테스트")} 는`);
        expect(await render("'테스트'입니다.")).toBe(`${Q1("테스트")}입니다.`);
        expect(await render("'옥좌'에")).toBe(`${Q1("옥좌")}에`);
        expect(await render('"테스트"는')).toBe(`${Q2("테스트")}는`);
        expect(await render('"안녕"이라고')).toBe(`${Q2("안녕")}이라고`);
    });

    it("the exact lines from the bug report", async () => {
        const input = ["'테스트'", "'테스트'는", "'테스트' 는", "'테스트'입니다.", '"테스트"는'].join("\n");
        expect(await render(input)).toBe(
            [
                Q1("테스트"),
                `${Q1("테스트")}는`,
                `${Q1("테스트")} 는`,
                `${Q1("테스트")}입니다.`,
                `${Q2("테스트")}는`,
            ].join("<br>\n"),
        );
    });

    it("English apostrophes are not turned into quote marks", async () => {
        expect(await render("don't")).toBe("don’t");
        expect(await render("it's")).toBe("it’s");
        expect(await render("John's")).toBe("John’s");
        expect(await render("He said 'don't' and left.")).toBe(`He said ${Q1("don’t")} and left.`);
        expect(await render("\"It's John's,\" she said.")).toBe(`${Q2("It’s John’s,")} she said.`);
    });

    it("mixed-language sentences", async () => {
        expect(await render("'한국어'English")).toBe(`${Q1("한국어")}English`);
        expect(await render("'A'는")).toBe(`${Q1("A")}는`);
        expect(await render('"안녕"이라고 말했다.')).toBe(`${Q2("안녕")}이라고 말했다.`);
        expect(await render("그녀는 \"I don't know\"라고 했다.")).toBe(`그녀는 ${Q2("I don’t know")}라고 했다.`);
    });

    it("smart quotes typed directly are normalised and highlighted the same way", async () => {
        expect(await render("‘테스트’는")).toBe(`${Q1("테스트")}는`);
        expect(await render("“테스트”는")).toBe(`${Q2("테스트")}는`);
    });
});
