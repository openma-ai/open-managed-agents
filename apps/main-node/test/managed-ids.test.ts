import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createManagedIdGenerator, managedIdPrefixes } from "../src/managed-ids";

// Every namespace the official application modules ask the id generator for,
// with the prefix the Node control plane has always minted for it. A change
// here changes the shape of ids stored in operators' databases.
const expectedPrefixes: Record<string, string> = {
  agent: "agent",
  environment: "env",
  file: "file",
  memory_store: "memstore",
  "user-profile": "uprof",
  "environment-work": "work",
  deployment: "depl",
  "deployment-run": "drun",
  dream: "dream",
  memory: "mem",
  "memory-version": "memver",
  tunnel: "tnl",
  "tunnel-certificate": "tcrt",
  skill: "skill",
  "skill-version": "skv",
  credential: "vcrd",
  vault: "vlt",
};

describe("managed id generator", () => {
  it("mints the historical prefix for every known namespace", () => {
    const ids = createManagedIdGenerator();
    for (const [namespace, prefix] of Object.entries(expectedPrefixes)) {
      expect(ids.next(namespace), namespace).toMatch(new RegExp(`^${prefix}_[A-Za-z0-9_-]{21}$`));
    }
    expect(Object.keys(managedIdPrefixes).sort()).toEqual(Object.keys(expectedPrefixes).sort());
  });

  it("uses the namespace itself as the prefix for anything else", () => {
    expect(createManagedIdGenerator().next("session")).toMatch(/^session_[A-Za-z0-9_-]{21}$/);
  });

  it("mints skill version values as strictly increasing microsecond timestamps", () => {
    const ids = createManagedIdGenerator({ now: () => 1_700_000_000_000 });
    const first = ids.next("skill-version-value");
    const second = ids.next("skill-version-value");
    const third = ids.next("skill-version-value");
    expect(first).toBe("1700000000000000");
    expect(BigInt(second)).toBe(BigInt(first) + 1n);
    expect(BigInt(third)).toBe(BigInt(second) + 1n);
    // Time moving forward wins over the +1 fallback.
    const later = createManagedIdGenerator({ now: () => 1_700_000_000_001 });
    expect(later.next("skill-version-value")).toBe("1700000000001000");
  });

  it("is minted by the same generator for every id, unique across namespaces", () => {
    const ids = createManagedIdGenerator();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const namespace of Object.keys(expectedPrefixes)) seen.add(ids.next(namespace));
    }
    expect(seen.size).toBe(200 * Object.keys(expectedPrefixes).length);
  });
});

describe("Node control plane composition", () => {
  it("assembles one managed platform graph per process", () => {
    const source = readFileSync(resolve(__dirname, "../src/control-plane.ts"), "utf8");
    const calls = source.match(/createNodePlatform\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(source).not.toMatch(/managed(Agents|EnvironmentWork|Deployments|Dreams|Tunnels|Skills|Credentials)Platform\b/);
  });
});
