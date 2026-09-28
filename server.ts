import fs from "fs";
import path from "path";

const isDevScript = process.env.npm_lifecycle_event === "dev";
const distServer = path.join(process.cwd(), "dist", "server.cjs");

if (!isDevScript && fs.existsSync(distServer)) {
  await import("./dist/server.cjs");
} else {
  await import("./server_app.ts");
}
