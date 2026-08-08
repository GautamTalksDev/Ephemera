import {
  listReconcileCandidateIds,
  type Db,
} from "@ephemera/api/db";
import { enqueueReconcile } from "@ephemera/api/queue/reconcile";

/** Enqueue stale / non-terminal environments for reconciliation. */
export async function scanAndEnqueue(db: Db, staleAfterMs = 10_000): Promise<number> {
  const ids = await listReconcileCandidateIds(db, staleAfterMs);
  for (const id of ids) {
    await enqueueReconcile(id);
  }
  return ids.length;
}
