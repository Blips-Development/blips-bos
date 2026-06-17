import { testRun } from "./pipeline";
import {
  bunkerCollectionScheduled,
  bunkerCollectionOnDemand,
  bunkerCollectionRun,
  bunkerScheduledCheck,
} from "./bunker";
import { stokerProcess } from "./stoker";
import { furnaceProcess } from "./furnace";
import { boilerProcess } from "./boiler";
import { boilerV2Generate } from "./boiler-v2";
import { boilerV2RenderMockup } from "./boiler-v2-mockup";

/**
 * Inngest function registry — every function the app exposes.
 *
 * Passed to `serve()` in `/api/inngest/route.ts` so Inngest Cloud can
 * discover and invoke them. Adding a new function = import here + list.
 */
export const functions = [
  testRun,
  bunkerCollectionScheduled,
  bunkerCollectionOnDemand,
  bunkerCollectionRun,
  bunkerScheduledCheck,
  stokerProcess, // Phase 9C
  furnaceProcess, // Phase 10C
  boilerProcess, // Phase 11C
  boilerV2Generate, // Phase 11D.3a
  boilerV2RenderMockup, // Phase 11D.5c
];
