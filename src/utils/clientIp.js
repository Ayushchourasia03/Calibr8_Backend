import net from "net";

/**
 * Rate-limit bucket for the client address. IPv6 clients usually control a
 * whole /64, so per-address buckets would be trivial to rotate through: IPv6
 * addresses are grouped by their /64 prefix. IPv4-mapped IPv6 (::ffff:a.b.c.d)
 * is treated as IPv4.
 */
export function clientIpKey(req) {
  const raw = String(req?.ip || req?.socket?.remoteAddress || "unknown");
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (net.isIPv6(raw)) return `${ipv6Prefix64(raw)}::/64`;
  return raw;
}

function ipv6Prefix64(address) {
  const [head, tail = ""] = address.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const full = address.includes("::")
    ? [...headParts, ...Array(missing).fill("0"), ...tailParts]
    : headParts;
  return full
    .slice(0, 4)
    .map((part) => (parseInt(part || "0", 16) || 0).toString(16))
    .join(":");
}
