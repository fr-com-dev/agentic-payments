// SPEC v1.29.3 (SEC-54): an RPC endpoint's URL (`BASE_SEPOLIA_RPC_URL`) can hold a provider's API key in its path, its
// query or a user name and password. viem names the endpoint in full in its errors (it hides only a user name and
// password), and L3 used to put that text in a report's `detail`, which L2 keeps in its append-only ledger and L1
// reads. So nothing a process prints or reports carries more of a URL than its origin: what L3 prints at startup
// goes through `rpcLabel`, and any text that can carry an RPC library's error goes through `redactUrls`.
//
// A key in the host name itself (rare among providers) is still shown: the origin is what an operator needs to tell
// one endpoint from another.

/** A URL as it may be shown: `scheme://host[:port]`, then `/…` when it had a path, a query, a fragment or credentials. */
export function rpcLabel(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "<not a URL>";
  }
  if (u.origin === "null") return `${u.protocol}…`;
  const more = u.username !== "" || u.password !== "" || (u.pathname !== "" && u.pathname !== "/") || u.search !== "" || u.hash !== "";
  return more ? `${u.origin}/…` : u.origin;
}

/** Anything that starts like a URL with a scheme, up to a space, a quote or a closing bracket. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()[\]{}]+/gi;

/** `text` with every URL in it cut to `rpcLabel`'s form. */
export function redactUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (found) => rpcLabel(found));
}
