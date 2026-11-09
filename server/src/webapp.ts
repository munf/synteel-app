// Self-hosting (Dockerfile, compose.yaml): one process serves both the API and the built app (web/dist),
// the way Caddy does on eel.synt.fun: /api/* goes to the server, everything else is a file from the build.
// Unset SYNTEEL_WEB_DIR (the eel.synt.fun services) leaves the server answering /api only.
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

/** The API app (basePath /api) plus the built app's files from `dir`. A missing file is a 404, as with Caddy. */
export function withWebApp(api: { fetch: (req: Request, env?: unknown) => Response | Promise<Response> }, dir: string) {
  const site = new Hono();
  // The request goes through unchanged, with Node's connection bindings (c.env).
  site.all('/api/*', (c) => api.fetch(c.req.raw, c.env));
  site.use('/*', serveStatic({ root: dir }));
  return site;
}
