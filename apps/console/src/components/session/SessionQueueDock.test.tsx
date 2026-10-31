import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionQueueDock } from "./SessionQueueDock";

const items = [
  { id: "m1", key: "m1", text: "first queued" },
  { id: "m2", key: "m2", text: "second queued" },
];

const noop = {
  onBeginEdit: vi.fn(async () => ({ status: "allowed" as const })),
  onCommitEdit: vi.fn(),
  onAbandonEdit: vi.fn(),
  onRemove: vi.fn(),
};

describe("SessionQueueDock (Backchat queued-prompt banner)", () => {
  it("renders nothing when the queue is empty", () => {
    const { container } = render(
      <SessionQueueDock items={[]} {...noop} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders one row per queued message with no Steer control when steering is unsupported", () => {
    render(<SessionQueueDock items={items} {...noop} />);
    expect(screen.getByLabelText("2 queued")).toBeTruthy();
    expect(screen.getByText("first queued")).toBeTruthy();
    expect(screen.queryByText("Steer")).toBeNull();
  });

  it("remove and steer call the server-backed callbacks with the message id", () => {
    const onRemove = vi.fn();
    const onSteer = vi.fn();
    render(
      <SessionQueueDock items={items} {...noop} onRemove={onRemove} onSteer={onSteer} />,
    );
    fireEvent.click(screen.getByLabelText("Remove queued message 2"));
    fireEvent.click(screen.getByLabelText("Steer queued message 1"));
    expect(onRemove).toHaveBeenCalledWith("m2");
    expect(onSteer).toHaveBeenCalledWith("m1");
  });

  it("enter-edit fires cancel immediately; Save re-enqueues only when allowed", async () => {
    const onBeginEdit = vi.fn(async () => ({ status: "allowed" as const }));
    const onCommitEdit = vi.fn();
    render(
      <SessionQueueDock
        items={items}
        {...noop}
        onBeginEdit={onBeginEdit}
        onCommitEdit={onCommitEdit}
      />,
    );
    fireEvent.click(screen.getByLabelText("Edit queued message 1"));
    await waitFor(() => expect(onBeginEdit).toHaveBeenCalledWith("m1"));
    const input = await screen.findByLabelText("Queued message 1");
    fireEvent.change(input, { target: { value: "edited" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onCommitEdit).toHaveBeenCalledWith("m1", "edited");
  });

  it("enter-edit abandon keeps draft via onAbandonEdit when cancel says already_processing", async () => {
    const onBeginEdit = vi.fn(async () => ({
      status: "abandoned" as const,
      reason: "already_processing",
    }));
    const onAbandonEdit = vi.fn();
    render(
      <SessionQueueDock
        items={items}
        {...noop}
        onBeginEdit={onBeginEdit}
        onAbandonEdit={onAbandonEdit}
      />,
    );
    fireEvent.click(screen.getByLabelText("Edit queued message 1"));
    await waitFor(() =>
      expect(onAbandonEdit).toHaveBeenCalledWith("m1", "first queued", "already_processing"),
    );
    expect(screen.queryByLabelText("Queued message 1")).toBeNull();
  });

  it("locks a row while a server action (e.g. edit) is in flight", () => {
    render(
      <SessionQueueDock
        items={[{ ...items[0]!, busy: "editing" }]}
        {...noop}
      />,
    );
    expect((screen.getByLabelText("Remove queued message 1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Edit queued message 1") as HTMLButtonElement).disabled).toBe(true);
  });
});
