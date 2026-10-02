import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { invalid } from "../errors";

/**
 * Fetches a remote URL on behalf of a user without letting them reach internal
 * services (SSRF). Every resolved address is validated at connect time, so DNS
 * rebinding can't swap in a private IP after the check.
 */
function isPrivateIPv4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number) as [number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT (also Alibaba's metadata service)
    (a === 169 && b === 254) || // link-local, cloud metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address (handles "::" and a trailing dotted IPv4), or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (!net.isIPv4(dotted[1]!)) return null;
    const [a, b, c, d] = dotted[1]!.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, -dotted[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * True for any address a user-supplied URL must not reach: private, loopback, link-local,
 * metadata, multicast and reserved ranges — including IPv4 hidden inside IPv6 (mapped,
 * compatible, NAT64, 6to4) and Teredo tunnels.
 */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return isPrivateIPv4(address);
  const g = ipv6Groups(address);
  if (!g) return true; // not an address we understand: refuse
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && g5 === 0) return g6 === 0 && g7 <= 1 ? true : isPrivateIPv4(v4From(g6, g7)); // ::, ::1, ::a.b.c.d
  if (zeroPrefix && g5 === 0xffff) return isPrivateIPv4(v4From(g6, g7)); // ::ffff:a.b.c.d (in any spelling)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIPv4(v4From(g6, g7)); // NAT64
  if (g0 === 0x2002) return isPrivateIPv4(v4From(g1, g2)); // 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00 || zeroPrefix;
}

/** Hosts given as an IP literal never go through DNS lookup, so they are checked here. */
function assertPublicHost(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host)) throw invalid("That address isn't allowed.");
}

const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || list.length === 0) return callback(new Error("Blocked address"), "", 4);
    const first = list[0]!;
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, first.address, first.family);
  });
};

export interface SafeFetchResult {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
}

function requestOnce(url: URL, maxBytes: number, timeoutMs: number): Promise<{ status: number; location?: string; contentType: string; buffer?: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    // `timeout` below only covers idle sockets; this caps the whole request (a slow drip can't hold it open).
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs * 3);
    const settle = <T,>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(deadline);
      fn(v);
    };
    resolve = settle(resolve);
    reject = settle(reject);
    const req = client.get(
      url,
      {
        lookup: guardedLookup,
        timeout: timeoutMs,
        headers: { "user-agent": "ForgeStudio/1.0 (+media import)", accept: "image/*,video/*;q=0.8" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, location: res.headers.location, contentType: "" });
        }
        if (status !== 200) {
          res.resume();
          return reject(invalid(`The server responded with status ${status}.`));
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > maxBytes) {
          res.destroy();
          return reject(invalid("That file is too large to import."));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(invalid("That file is too large to import."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({ status, contentType: String(res.headers["content-type"] ?? ""), buffer: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => {
      if (error.message === "Blocked address") reject(invalid("That address isn't allowed."));
      else if (error.message === "timeout") reject(invalid("The remote server took too long to respond."));
      else reject(invalid("Couldn't download that URL."));
    });
  });
}

export async function safeFetch(rawUrl: string, options: { maxBytes: number; timeoutMs?: number }): Promise<SafeFetchResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalid("That doesn't look like a valid URL.");
  }
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid("Only http(s) links can be imported.");
    if (url.username || url.password) throw invalid("Links with credentials can't be imported.");
    if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) throw invalid("That port isn't allowed.");
    assertPublicHost(url);
    const result = await requestOnce(url, options.maxBytes, options.timeoutMs ?? 10_000);
    if (result.location) {
      url = new URL(result.location, url);
      continue;
    }
    return { buffer: result.buffer!, contentType: result.contentType, finalUrl: url.toString() };
  }
  throw invalid("Too many redirects.");
}
