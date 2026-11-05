function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Offline browser handoff page. Title and body are plain text, never markup. */
export function approvalPage(title: string, body: string): string {
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} · openma</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #f7f8fa;
      color: #20242c;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    main {
      width: 100%;
      max-width: 480px;
      padding: 40px 28px;
      border: 1px solid #e3e6eb;
      border-radius: 16px;
      background: #fff;
      box-shadow: 0 4px 24px rgba(24, 32, 48, 0.04);
      text-align: center;
      overflow-wrap: anywhere;
    }
    .wordmark { margin: 0 0 24px; color: #68707d; font-size: 13px; font-weight: 600; }
    h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.025em; }
    .message { margin: 12px 0 0; color: #596170; font-size: 15px; }
  </style>
</head>
<body>
  <main aria-labelledby="title">
    <p class="wordmark">openma</p>
    <h1 id="title">${safeTitle}</h1>
    <p class="message">${escapeHtml(body)}</p>
  </main>
</body>
</html>`;
}
