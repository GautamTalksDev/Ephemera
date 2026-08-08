import {
  listExpiredRunningEnvironmentIds,
  listKnownProviderRefs,
  updateEnvironmentState,
  type Db,
} from "@ephemera/api/db";
import { enqueueReconcile } from "@ephemera/api/queue/reconcile";
import {
  destroyMockProviderRef,
  listMockProviderRefs,
} from "@ephemera/core";

/**
 * Reaper:
 * 1) Flip desiredState=destroyed on expired environments.
 * 2) Destroy provider resources with no matching DB row (orphan sweep).
 */
export async function runReaper(db: Db): Promise<{
  expired: number;
  orphans: number;
}> {
  const expiredIds = await listExpiredRunningEnvironmentIds(db);
  for (const id of expiredIds) {
    await updateEnvironmentState(db, id, { desiredState: "destroyed" });
    await enqueueReconcile(id);
  }

  const known = new Set(await listKnownProviderRefs(db));
  const live = listMockProviderRefs();
  let orphans = 0;
  for (const ref of live) {
    if (!known.has(ref)) {
      await destroyMockProviderRef(ref);
      orphans += 1;
    }
  }

  return { expired: expiredIds.length, orphans };
}
