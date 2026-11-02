import { useContext } from "react";
import { MotionConfigContext } from "motion/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ModernLoginShell } from "./modern-login-signup";

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("motion/react")>(),
  useReducedMotion: () => preference.reduced,
}));

function MotionPolicy() {
  const policy = useContext(MotionConfigContext);
  return <output aria-label="Motion duration">{policy.transition?.duration}</output>;
}

it.each([[false, "0.28"], [true, "0"]] as const)("respects reduced motion=%s without blocking form controls", async (reduced, duration) => {
  preference.reduced = reduced;
  const submit = vi.fn();
  render(<ModernLoginShell><MotionPolicy /><button onClick={submit}>Send code</button></ModernLoginShell>);
  expect(screen.getByLabelText("Motion duration")).toHaveTextContent(duration);
  await userEvent.click(screen.getByRole("button", { name: "Send code" }));
  expect(submit).toHaveBeenCalledOnce();
});
