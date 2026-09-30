import { api } from "../../../lib/api-client";
import type { SlpActionInput, SlpActionName, SlpActionResult } from "../../../../../shared/src/slp/slp-actions.js";

/** One call into Slurp's action layer (`POST /slurp/actions/:name`), typed by the shared contract. */
export function runSlpAction<N extends SlpActionName>(name: N, input: SlpActionInput<N>): Promise<SlpActionResult[N]> {
  return api.post<SlpActionResult[N]>(`/slurp2/slurp/actions/${name}`, input);
}
