// Generic admission hook for work on an existing Session. The Port types live
// in @openma/core; OSS carries no policy and admits everything by default.

import type { SessionWorkAdmissionPort } from "@openma/core";

export const admitAllSessionWork: SessionWorkAdmissionPort = {
  admit: async () => ({ type: "allowed" }),
};
