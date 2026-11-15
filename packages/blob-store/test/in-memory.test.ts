import { expect, it } from "vitest";
import { InMemoryBlobStore } from "../src/adapters/in-memory";

it.each(["create", "replace"] as const)("checks %s preconditions at commit after reading an asynchronous body", async operation => {
  const store = new InMemoryBlobStore();
  const original = await store.put("process", "original");
  if (operation === "create") await store.delete("process");
  let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      finish = () => {
        controller.enqueue(new TextEncoder().encode("stale"));
        controller.close();
      };
    },
  });
  const pending = store.put("process", body, {
    precondition: operation === "create"
      ? { type: "ifNoneMatch", value: "*" }
      : { type: "ifMatch", etag: original!.etag },
  });
  await store.put("process", "confirmed");
  finish();
  expect(await pending).toBeNull();
  expect(await (await store.get("process"))!.text()).toBe("confirmed");
});
