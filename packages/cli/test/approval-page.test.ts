import { describe, expect, it } from "vitest";
import { approvalPage } from "../src/approval-page.js";

describe("browser handoff page", () => {
  it.each(["Signed in", "Machine connected"])("renders %s as a complete offline HTML page", (title) => {
    const body = "You can close this tab and return to the terminal.";
    const html = approvalPage(title, body);

    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(`<title>${title} · openma</title>`);
    expect(html).toContain(`<h1 id="title">${title}</h1>`);
    expect(html).toContain(`<p class="message">${body}</p>`);
    expect(html).toContain('name="viewport"');
    expect(html).toContain("<style>");
    expect(html).toContain("font-family: system-ui");
    expect(html).not.toMatch(/<script|<link|<img|@import|url\(/i);
    expect(html).toMatch(/<\/html>$/);
  });

  it("escapes error text in the document title, heading and body", () => {
    const html = approvalPage('Cancelled <login> & "setup"', "Login was cancelled: <script>alert('x')</script>.");

    expect(html).toContain("<title>Cancelled &lt;login&gt; &amp; &quot;setup&quot; · openma</title>");
    expect(html).toContain('<h1 id="title">Cancelled &lt;login&gt; &amp; &quot;setup&quot;</h1>');
    expect(html).toContain("Login was cancelled: &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;.");
    expect(html).not.toContain("<script>");
  });
});
