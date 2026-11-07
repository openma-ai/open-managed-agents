import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTEGRATION_AVATAR,
  INTEGRATION_AVATARS,
  getIntegrationAvatarUrl,
  isIntegrationAvatarUrl,
} from "../../packages/integrations-core/src/avatars";

describe("integration avatars", () => {
  it("mints URLs on the console host that serves apps/console/public", () => {
    // openma.ai (marketing) has no /integration-avatars/ route and
    // openma.dev 301s there, so both 404. app.openma.ai serves the files.
    expect(getIntegrationAvatarUrl("1_01")).toBe(
      "https://app.openma.ai/integration-avatars/avatar_1_01.png",
    );
    expect(DEFAULT_INTEGRATION_AVATAR.url).toBe(getIntegrationAvatarUrl("1_01"));
    for (const avatar of INTEGRATION_AVATARS) {
      expect(avatar.url.startsWith("https://app.openma.ai/integration-avatars/avatar_")).toBe(true);
    }
  });

  it("still recognises avatar URLs stored before the openma.ai move", () => {
    expect(isIntegrationAvatarUrl("https://app.openma.ai/integration-avatars/avatar_2_03.png")).toBe(true);
    expect(isIntegrationAvatarUrl("https://openma.dev/integration-avatars/avatar_2_03.png")).toBe(true);
  });

  it("rejects arbitrary hosts and non-avatar files", () => {
    expect(isIntegrationAvatarUrl("https://example.com/integration-avatars/avatar_1_01.png")).toBe(false);
    expect(isIntegrationAvatarUrl("https://openma.ai/integration-avatars/avatar_1_01.png")).toBe(false);
    expect(isIntegrationAvatarUrl("https://app.openma.ai/integration-avatars/avatar_1_01.svg")).toBe(false);
    expect(isIntegrationAvatarUrl("https://app.openma.ai/integration-avatars/logo.png")).toBe(false);
  });
});
