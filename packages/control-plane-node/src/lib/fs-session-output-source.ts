import { stat as fsStat, readdir as fsReaddir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { guessSessionOutputMime } from "@open-managed-agents/shared";
import {
  compareFilename,
  isSafeOutputFilename,
  type SessionOutputObject,
  type SessionOutputPageSource,
} from "@open-managed-agents/files-store";

/**
 * Session-output page source over the node outputs directory
 * (`<root>/<tenant>/<session>/<filename>`). Names sort with the same
 * code-unit order as the R2 adapter so a cursor means the same thing
 * on both deployments.
 */
export function createFsSessionOutputSource(outputsRoot: string): SessionOutputPageSource {
  return {
    async listAfter(input) {
      const dir = resolve(outputsRoot, input.tenantId, input.sessionId);
      let names: string[];
      try {
        names = await fsReaddir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const objects: SessionOutputObject[] = [];
      for (const filename of names) {
        if (!isSafeOutputFilename(filename)) continue;
        if (input.startAfterFilename !== undefined && !(filename > input.startAfterFilename)) continue;
        try {
          const st = await fsStat(join(dir, filename));
          if (!st.isFile()) continue;
          objects.push({
            filename,
            sizeBytes: st.size,
            uploadedAtMs: Math.trunc(st.mtimeMs),
            mediaType: guessSessionOutputMime(filename),
          });
        } catch {
          /* skip unreadable entries */
        }
      }
      objects.sort((a, b) => compareFilename(a.filename, b.filename));
      return objects.slice(0, input.limit);
    },
  };
}
