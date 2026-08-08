import { claimNextEnvironment, createDb, createPool } from "../apps/api/src/db/index.js";

const label = process.argv[2] ?? "worker";

const pool = createPool();
const db = createDb(pool);

try {
  const claimed = await claimNextEnvironment(db);
  if (!claimed) {
    console.log(JSON.stringify({ label, id: null }));
  } else {
    console.log(
      JSON.stringify({
        label,
        id: claimed.id,
        actualState: claimed.actualState,
        prNumber: claimed.prNumber,
      }),
    );
  }
} finally {
  await pool.end();
}
