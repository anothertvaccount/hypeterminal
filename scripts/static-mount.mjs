/** Local static-host simulator: serves the built public dir mounted at /terminal/ (SPA fallback). */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve("apps/terminal/.output/public");
const PREFIX = "/terminal/";
const types = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".txt": "text/plain",
};
http
	.createServer((req, res) => {
		const p = decodeURIComponent((req.url ?? "/").split("?")[0]);
		if (!p.startsWith(PREFIX)) {
			res.writeHead(404);
			return res.end("outside mount");
		}
		const rel = p.slice(PREFIX.length) || "index.html";
		let file = path.join(ROOT, rel);
		if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
		res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
		fs.createReadStream(file)
			.on("error", () => res.end())
			.pipe(res);
	})
	.listen(Number(process.env.PORT ?? 3300), () => console.log("static mount listening"));
