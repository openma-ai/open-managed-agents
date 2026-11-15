import { describeSessionUsageStoreConformance } from "./session-usage-store-conformance";
import { memorySessionUsageStore } from "../src/sessions/budget";

describeSessionUsageStoreConformance("memory", () => memorySessionUsageStore());
