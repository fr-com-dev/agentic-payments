// 017: one request on node:http, for tests whose `Host` header or raw path matters (T-PRT-16, T-PRT-17, T-EDGE-03,
// T-EDGE-06). `fetch` can't send another `Host` than the URL's and normalizes `%2e%2e` and `..` segments before
// sending, so neither a public host name nor a traversal payload would reach the service as a scanner sends it.
import { request, type IncomingHttpHeaders } from "node:http";

export interface RawRequest {
  method?: string;
  /** Sent byte for byte: no normalization of `%2e%2e`, `..` or `\`. */
  path: string;
  headers?: Record<string, string>;
  /** The `Host` header: a string sends it, `null` sends none, omitted sends the base's `host:port`. */
  host?: string | null;
  body?: string;
}

export interface RawReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** The body parsed as JSON, or undefined when it isn't JSON. */
  json: unknown;
}

export function rawRequest(base: string, o: RawRequest): Promise<RawReply> {
  const url = new URL(base);
  const host = o.host === undefined ? url.host : o.host;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        method: o.method ?? "GET",
        path: o.path,
        setHost: false,
        headers: { ...(host !== null && { host }), ...o.headers, connection: "close" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = body.length > 0 ? JSON.parse(body) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}
