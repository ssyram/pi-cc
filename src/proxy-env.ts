/**
 * Proxy environment resolution for the turn relay's upstream connection.
 * Node's http/https modules ignore proxy environment variables; the relay
 * resolves them explicitly and tunnels through an HTTP CONNECT proxy.
 */

export type ProxyEnv = Record<string, string | undefined>;

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

function noProxyMatches(list: string | undefined, hostname: string): boolean {
  if (!list) return false;
  const target = hostname.toLowerCase();
  for (const rawEntry of list.split(/[,\s]+/)) {
    const entry = rawEntry.trim().toLowerCase().replace(/^\.+/, "");
    if (entry === "") continue;
    if (entry === "*") return true;
    if (target === entry || target.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * Resolve the proxy URL for an upstream target from proxy environment
 * variables. Only HTTPS targets are proxied (HTTP targets are loopback test
 * fixtures). Honors NO_PROXY. Throws for a proxy URL that is not an HTTP
 * proxy, because silently connecting directly would change reachability.
 */
export function resolveUpstreamProxy(env: ProxyEnv, target: URL): URL | undefined {
  if (target.protocol !== "https:") return undefined;
  const raw = firstNonEmpty(env.HTTPS_PROXY, env.https_proxy, env.ALL_PROXY, env.all_proxy);
  if (raw === undefined) return undefined;
  if (noProxyMatches(env.NO_PROXY ?? env.no_proxy, target.hostname)) return undefined;
  const proxy = new URL(raw);
  if (proxy.protocol !== "http:") {
    throw new Error(
      `Claude Code relay upstream proxy must be an HTTP proxy (CONNECT tunnel), got: ${proxy.protocol}`,
    );
  }
  return proxy;
}
