import { BlockList, isIP } from "node:net";

/** Bun Fetch's supported environment selection, evaluated separately for every hop. */
export function rawHttpProxy(url: URL, environment: NodeJS.ProcessEnv = process.env): URL | undefined {
  const value = (name: string) => environment[name.toLowerCase()] || environment[name] || "";
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const excluded = value("NO_PROXY").split(/[,\s]+/).filter(Boolean).some(raw => {
    if (raw === "*") return true;
    const entry = raw.toLowerCase();
    const cidr = entry.split("/");
    if (cidr.length === 2 && isIP(cidr[0]) && /^\d+$/.test(cidr[1])) {
      const family = isIP(cidr[0]), prefix = Number(cidr[1]);
      if (prefix > (family === 4 ? 32 : 128) || isIP(hostname) !== family) return false;
      const list = new BlockList(); list.addSubnet(cidr[0], prefix, family === 4 ? "ipv4" : "ipv6");
      return list.check(hostname, family === 4 ? "ipv4" : "ipv6");
    }
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    const rule = match ? match[1] : entry;
    if (match?.[2] && match[2] !== port) return false;
    const host = rule.replace(/^\[|\]$/g, "").replace(/^\*?\./, "");
    return hostname === host || !isIP(host) && hostname.endsWith(`.${host}`);
  });
  if (excluded) return undefined;
  const configured = value(url.protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY") || value("ALL_PROXY");
  if (!configured) return undefined;
  const proxy = new URL(configured.includes("://") ? configured : `http://${configured}`);
  if (!["http:", "https:"].includes(proxy.protocol)) throw new TypeError("The configured HTTP proxy protocol is unsupported; no direct connection was attempted.");
  return proxy;
}
