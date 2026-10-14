// Dev server without HMR: Bun's HMR breaks when index.html and main.ts change together.
// Reload the page manually after edits.
import index from "./index.html";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: { "/": index },
  development: { hmr: false, console: true },
});
console.log(`typebook dev: ${server.url}`);
