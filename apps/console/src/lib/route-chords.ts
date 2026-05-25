/* ── Linear-style chord keybindings (g + letter → route) ──
 *
 * Mapping is path → second-key. Prefix is always "g". Letter choice
 * follows Linear's convention (first letter of the route) wherever
 * possible; clashes are resolved with the second-most-meaningful letter:
 *
 *   k is taken by Skills, so API Keys uses `i` ("key id")
 *   e is taken by Environments, so Eval Runs uses `h` ("hist")
 *
 * Exported here (not in AppShell) so CommandPalette can render the same
 * chord next to each route without forcing the layout file to be
 * imported into the palette (and vice versa — both can read from this
 * single source). */
export const ROUTE_CHORDS: Record<string, string> = {
  "/":              "d",
  "/agents":        "a",
  "/sessions":      "s",
  "/files":         "f",
  "/environments":  "e",
  "/vaults":        "v",
  "/skills":        "k",
  "/memory":        "m",
  "/model-cards":   "c",
  "/api-keys":      "i",
  "/runtimes":      "r",
  "/evals":         "h",
};
