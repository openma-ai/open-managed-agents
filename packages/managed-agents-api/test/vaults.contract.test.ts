import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { VaultsApplicationPort } from "../src/index";
import { buildVaultsTestApi } from "./test-api";
import { makeVaultsPort, vaultView } from "./vault-fixtures";

function makeClient(port: VaultsApplicationPort): Anthropic {
  const api = buildVaultsTestApi(port);
  return new Anthropic({
    apiKey: "test-key",
    baseURL: "http://openma.test",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
      return api.fetch(request);
    },
  });
}

describe("Managed Agents API — vaults", () => {
  it("creates a vault through an application-native command", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeVaultsPort({
        createVault: async (command) => {
          calls.push(command);
          return { type: "created", vault: vaultView };
        },
      }),
    );

    const vault = await client.beta.vaults.create({
      display_name: "Production credentials",
      metadata: { team: "platform" },
    });

    expect(calls).toEqual([
      {
        displayName: "Production credentials",
        metadata: { team: "platform" },
      },
    ]);
    expect(vault).toEqual({
      id: "vlt_01",
      archived_at: null,
      created_at: "2026-08-26T10:00:00.000Z",
      display_name: "Production credentials",
      metadata: { team: "platform" },
      type: "vault",
      updated_at: "2026-08-26T10:00:00.000Z",
    });
  });

  it("retrieves a vault without leaking its wire identifier name", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeVaultsPort({
        retrieveVault: async (query) => {
          calls.push(query);
          return { type: "found", vault: vaultView };
        },
      }),
    );

    const vault = await client.beta.vaults.retrieve("vlt_01");

    expect(calls).toEqual([{ vaultId: "vlt_01" }]);
    expect(vault).toMatchObject({ id: "vlt_01", type: "vault" });
  });

  it("updates nullable fields and metadata patch semantics", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeVaultsPort({
        updateVault: async (command) => {
          calls.push(command);
          return { type: "updated", vault: vaultView };
        },
      }),
    );

    await client.beta.vaults.update("vlt_01", {
      display_name: null,
      metadata: { owner: "runtime", obsolete: null },
    });

    expect(calls).toEqual([
      {
        vaultId: "vlt_01",
        displayName: null,
        metadata: { owner: "runtime", obsolete: null },
      },
    ]);
  });

  it("lists vaults with semantic pagination names", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeVaultsPort({
        listVaults: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: { vaults: [vaultView], nextCursor: "vault_page_02" },
          };
        },
      }),
    );

    const page = await client.beta.vaults.list({
      limit: 20,
      page: "vault_page_01",
      include_archived: true,
    });

    expect(calls).toEqual([
      {
        pageSize: 20,
        cursor: "vault_page_01",
        includeArchived: true,
      },
    ]);
    expect(page.data).toHaveLength(1);
    expect(page.next_page).toBe("vault_page_02");
  });

  it("deletes a vault and returns the official tombstone", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeVaultsPort({
        deleteVault: async (command) => {
          calls.push(command);
          return { type: "deleted", vaultId: "vlt_01" };
        },
      }),
    );

    const deleted = await client.beta.vaults.delete("vlt_01");

    expect(calls).toEqual([{ vaultId: "vlt_01" }]);
    expect(deleted).toEqual({ id: "vlt_01", type: "vault_deleted" });
  });

  it("archives a vault", async () => {
    const calls: unknown[] = [];
    const archivedVault = {
      ...vaultView,
      archivedAt: "2026-08-26T10:30:00.000Z",
      updatedAt: "2026-08-26T10:30:00.000Z",
    };
    const client = makeClient(
      makeVaultsPort({
        archiveVault: async (command) => {
          calls.push(command);
          return { type: "archived", vault: archivedVault };
        },
      }),
    );

    const vault = await client.beta.vaults.archive("vlt_01");

    expect(calls).toEqual([{ vaultId: "vlt_01" }]);
    expect(vault.archived_at).toBe("2026-08-26T10:30:00.000Z");
  });
});
