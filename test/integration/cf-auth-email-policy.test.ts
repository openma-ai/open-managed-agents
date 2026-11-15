import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../packages/shared/src/env";
import { createAuth } from "../../apps/main/src/auth-config";
import mainApp from "../../apps/main/src/index";

const origin = "https://app.example.test";
const password = "test-password-long-enough";
const baseEnv = () => ({ ...env, SEND_EMAIL: undefined, BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID() } as unknown as Env);
const request = (auth: ReturnType<typeof createAuth>, path: string, body?: unknown, cookie?: string) =>
  auth.handler(new Request(origin + "/auth" + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));

beforeAll(async () => {
  // Existing test worker applies the production D1 migrations on first request.
  await exports.default.fetch(new Request("http://localhost/health"));
});

describe("CF auth email policy (real better-auth HTTP + local D1)", () => {
  it.each([
    { sender: false, flag: undefined, verify: false, otp: false },
    { sender: false, flag: "0", verify: false, otp: false },
    { sender: true, flag: undefined, verify: true, otp: true },
    { sender: true, flag: "1", verify: true, otp: true },
    { sender: true, flag: "0", verify: false, otp: true },
  ])("public auth-info distinguishes optional OTP from verification: %j", async ({ sender, flag, verify, otp }) => {
    const bindings = { ...baseEnv(), AUTH_REQUIRE_EMAIL_VERIFY: flag,
      SEND_EMAIL: sender ? { send: async () => {} } as unknown as SendEmail : undefined,
    };
    const response = await mainApp.fetch(new Request(origin + "/auth-info"), bindings);
    expect(response.status).toBe(200);
    const info = await response.json() as { providers: string[]; require_email_verification: boolean; password_reset: boolean };
    expect(info.providers).toContain("email");
    expect(info.providers.includes("email-otp")).toBe(otp);
    expect(info.require_email_verification).toBe(verify);
    expect(info.password_reset).toBe(sender);
  });
  it.each([undefined, "0"])("no sender, flag %s: signs up and signs in without OTP, creates its own workspace", async (flag) => {
    const auth = createAuth({ ...baseEnv(), AUTH_REQUIRE_EMAIL_VERIFY: flag });
    const email = `self-${crypto.randomUUID()}@example.test`;
    const signup = await request(auth, "/sign-up/email", { email, password, name: "Self Host" });
    expect(signup.status).toBe(200);
    expect(signup.headers.get("set-cookie")).toContain("session_token=");
    const created = await signup.json() as { user: { id: string }; token: string | null };
    expect(created.token).toBeTruthy();
    const login = await request(auth, "/sign-in/email", { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const session = await request(auth, "/get-session", undefined, cookie);
    expect((await session.json() as { user: { id: string } }).user.id).toBe(created.user.id);
    const user = await env.MAIN_DB.prepare("SELECT tenantId, role, emailVerified FROM user WHERE id = ?").bind(created.user.id).first();
    expect(user).toMatchObject({ role: "owner", emailVerified: 0 });
    expect(user!.tenantId).toMatch(/^tn_/);
    const membership = await env.MAIN_DB.prepare("SELECT tenant_id, role FROM membership WHERE user_id = ?").bind(created.user.id).first();
    expect(membership).toEqual({ tenant_id: user!.tenantId, role: "owner" });
    const shard = await env.MAIN_DB.prepare("SELECT binding_name FROM tenant_shard WHERE tenant_id = ?").bind(user!.tenantId).first();
    expect(shard).toEqual({ binding_name: "MAIN_DB" });
  });

  it("does not report successful email delivery when no sender is configured", async () => {
    const auth = createAuth(baseEnv());
    const otp = await request(auth, "/email-otp/send-verification-otp", { email: "nobody@example.test", type: "forget-password" });
    expect(otp.status).toBe(404);
    // better-auth 1.6.3's negative APIError HTTP paths cause duplicate unhandled
    // rejections in the workerd Vitest pool. Check the actual (unmocked) factory
    // output here; OTP absence and all successful flows are HTTP assertions.
    expect(auth.options.emailAndPassword.sendResetPassword).toBeUndefined();
  });

  it("rejects explicit verification without a sender rather than silently relaxing it", () => {
    expect(() => createAuth({ ...baseEnv(), AUTH_REQUIRE_EMAIL_VERIFY: "1" })).toThrow("SEND_EMAIL");
  });

  it.each(["", "true", "false", " 0", "1 ", "secret-invalid-value"])("rejects invalid flag %j without echoing the value", (flag) => {
    expect(() => createAuth({ ...baseEnv(), AUTH_REQUIRE_EMAIL_VERIFY: flag })).toThrow(/^AUTH_REQUIRE_EMAIL_VERIFY must be 0 or 1$/);
  });

  it.each([undefined, "1"])("with sender, flag %s: retains verification gate and can verify via delivered OTP", async (flag) => {
    const messages: Array<{ text?: string }> = [];
    const auth = createAuth({ ...baseEnv(), AUTH_REQUIRE_EMAIL_VERIFY: flag,
      SEND_EMAIL: { send: async (message: { text?: string }) => { messages.push(message); } } as unknown as SendEmail,
      AUTH_COOKIE_DOMAIN: ".example.test", AUTH_COOKIE_NAME: "staging.session_token",
    });
    const email = `hosted-${crypto.randomUUID()}@example.test`;
    const signup = await request(auth, "/sign-up/email", { email, password, name: "Hosted" });
    expect(signup.status).toBe(200);
    expect((await signup.json() as { token: string | null }).token).toBeNull();
    // No session before verification; negative sign-in was independently
    // observed as HTTP 403, but triggers the pool's APIError rejection issue.
    expect(signup.headers.get("set-cookie")).toBeNull();
    const otp = messages.map(m => m.text?.match(/Verify your email: (\d{6})/)?.[1]).find(Boolean);
    expect(otp).toBeTruthy();
    const verify = await request(auth, "/email-otp/verify-email", { email, otp });
    expect(verify.status).toBe(200);
    const login = await request(auth, "/sign-in/email", { email, password });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("staging.session_token=");
    expect(login.headers.get("set-cookie")).toContain("Domain=.example.test");
  });

  it("honors explicit 0 even with sender configured", async () => {
    const messages: Array<{ text?: string }> = [];
    const auth = createAuth({ ...baseEnv(), AUTH_REQUIRE_EMAIL_VERIFY: "0", SEND_EMAIL: {
      send: async (message: { text?: string }) => { messages.push(message); },
    } as unknown as SendEmail });
    const email = `optout-${crypto.randomUUID()}@example.test`;
    const signup = await request(auth, "/sign-up/email", { email, password, name: "Opt Out" });
    expect(signup.status).toBe(200);
    expect((await signup.json() as { token: string | null }).token).toBeTruthy();
    expect((await request(auth, "/sign-in/email", { email, password })).status).toBe(200);
    const send = await request(auth, "/email-otp/send-verification-otp", { email, type: "sign-in" });
    expect(send.status).toBe(200);
    const otp = messages.map(m => m.text?.match(/Your sign-in code: (\d{6})/)?.[1]).find(Boolean);
    expect(otp).toBeTruthy();
    const otpLogin = await request(auth, "/sign-in/email-otp", { email, otp });
    expect(otpLogin.status).toBe(200);
    expect(otpLogin.headers.get("set-cookie")).toContain("session_token=");
  });
});
