import { expect, test } from "@playwright/test";

test("keeps the login chooser centered on a compact laptop viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 983, height: 697 });
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ json: null }),
  );
  await page.route("**/auth-info", (route) =>
    route.fulfill({
      json: {
        providers: ["email"],
        turnstile_site_key: null,
      },
    }),
  );

  await page.goto("/login");

  const account = page.getByRole("region", { name: "Account access" });
  const emailOption = page.getByRole("button", { name: "Continue with email" });

  await expect(account).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Log in to openma" }),
  ).toBeVisible();
  await expect(emailOption).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Openma platform story" }),
  ).toHaveCount(0);

  const optionBox = await emailOption.boundingBox();
  expect(optionBox).not.toBeNull();
  expect(Math.abs(optionBox!.x + optionBox!.width / 2 - 983 / 2)).toBeLessThan(2);
});
