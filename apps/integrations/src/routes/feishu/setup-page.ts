import { Hono } from "hono";
import type { Env } from "../../env";
import { buildFeishuContainer } from "../../wire";
import { buildProviders } from "../../providers";

// Public landing page for the non-admin handoff flow. The original publisher
// generates a /feishu-setup/<token> URL and shares it with their workspace
// admin. The admin opens it (no OMA login required), pastes their newly-
// registered Feishu App credentials, and clicks Continue.
//
// Security: the token IS the auth — anyone with the URL can complete the
// install. Treat the URL as sensitive. TTL is 60 min (the form-token JWT).

const app = new Hono<{ Bindings: Env }>();

app.get("/:token", async (c) => {
  const token = c.req.param("token");
  const container = buildFeishuContainer(c.env);

  let form: {
    persona: { name: string; avatarUrl: string | null };
    userId: string;
    publicationId?: string;
  };
  try {
    form = await container.jwt.verify<typeof form>(token);
  } catch (err) {
    return c.html(errorPage(err instanceof Error ? err.message : String(err)), 400);
  }

  // We don't have a manifest-launch URL for Feishu — apps are configured
  // in open.feishu.cn/app, which doesn't accept pre-filled manifests.
  const _feishu = buildProviders(c.env).feishu;
  void _feishu;

  return c.html(landingPage({ token, personaName: form.persona.name }));
});

function landingPage(opts: { token: string; personaName: string }): string {
  const escapedToken = escapeHtml(opts.token);
  const escapedName = escapeHtml(opts.personaName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Feishu app setup — ${escapedName}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #111; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p, li { color: #444; }
    code { background: #f2f2f2; padding: 1px 6px; border-radius: 4px; font-size: 13px; }
    label { display: block; font-weight: 600; margin: 16px 0 4px; }
    input { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font: inherit; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 16px; background: #00D6B9; color: #fff; border: 0; border-radius: 6px; font: inherit; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    .ok { color: #060; margin-top: 12px; }
    .err { color: #b00; margin-top: 12px; }
    details { margin: 12px 0 16px; }
    summary { cursor: pointer; color: #00a08a; font-weight: 500; }
  </style>
</head>
<body>
  <h1>Set up "${escapedName}" in your Feishu workspace</h1>
  <p>Someone on your team is installing OpenMA's <strong>${escapedName}</strong> agent
  into your Feishu workspace. Feishu App registration requires a workspace admin —
  that's where you come in.</p>

  <details open>
    <summary>Manual setup steps</summary>
    <ol>
      <li>Open <a href="https://open.feishu.cn/app" target="_blank">open.feishu.cn/app</a> and create (or select) the App you want to bind.</li>
      <li>In <strong>Credentials &amp; Basic Info</strong>, copy the <strong>App ID</strong>
          and <strong>App Secret</strong>.</li>
      <li>In <strong>Event Subscriptions</strong>, copy the <strong>Verification Token</strong>
          and <strong>Encrypt Key</strong>. (We use WebSocket long-poll for ingest, so you can
          leave the URL verification disabled.)</li>
      <li>In <strong>Permissions &amp; Scopes</strong>, grant at minimum:
          <code>im:message</code>, <code>im:message.group_at_msg</code>, <code>im:message.p2p_msg</code>,
          <code>im:message:read</code>, <code>im:message:send</code>.</li>
    </ol>
  </details>

  <p><strong>Paste your App credentials below and click Continue.</strong></p>

  <form id="f">
    <label for="appid">App ID</label>
    <input id="appid" name="appid" required autocomplete="off" placeholder="cli_…">
    <label for="appsec">App Secret</label>
    <input id="appsec" name="appsec" type="password" required autocomplete="off">
    <label for="vtok">Verification Token</label>
    <input id="vtok" name="vtok" type="password" required autocomplete="off">
    <label for="ekey">Encrypt Key</label>
    <input id="ekey" name="ekey" type="password" required autocomplete="off">
    <button id="submit" type="submit">Continue →</button>
    <p id="msg"></p>
  </form>

  <script>
    const TOKEN = ${JSON.stringify(escapedToken)};
    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("submit");
      const msg = document.getElementById("msg");
      btn.disabled = true;
      msg.textContent = "Validating…";
      msg.className = "";
      try {
        const res = await fetch("/feishu/publications/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formToken: TOKEN,
            appId: document.getElementById("appid").value.trim(),
            appSecret: document.getElementById("appsec").value.trim(),
            verificationToken: document.getElementById("vtok").value.trim(),
            encryptKey: document.getElementById("ekey").value.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.textContent = "Error: " + (data.details || data.error || res.status);
          msg.className = "err";
          btn.disabled = false;
          return;
        }
        msg.textContent = "Saved. Continue in the Console wizard…";
        msg.className = "ok";
        if (data.deeplink || data.returnUrl) {
          window.location.href = data.deeplink || data.returnUrl;
        }
      } catch (err) {
        msg.textContent = "Network error: " + err.message;
        msg.className = "err";
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html><body style="font:15px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 20px">
<h1>Link is invalid or expired</h1>
<p>${escapeHtml(message)}</p>
<p>Ask the original sender to generate a new setup link.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default app;

// Exported for unit tests. Pure function — no I/O, no module-level state.
export const _testInternals = { landingPage };