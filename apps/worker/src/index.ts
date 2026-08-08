import { VERSION } from "@ephemera/core";

console.log("worker up");
console.log(`@ephemera/core ${VERSION}`);

// Stay alive for local dev
setInterval(() => {}, 1 << 30);
