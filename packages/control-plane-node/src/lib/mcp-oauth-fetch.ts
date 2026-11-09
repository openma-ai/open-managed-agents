import { lookup } from "node:dns";
import { BlockList, type LookupFunction } from "node:net";
import { Agent } from "undici";

const nonPublic = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) nonPublic.addSubnet(network, prefix, "ipv4");

const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) nonPublic.addSubnet(network, prefix, "ipv6");

// Resolve in the socket connector so the exact checked DNS answers are used
// for the connection, while TLS still validates the original hostname.
const lookupPublic: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    if (addresses.length === 0 || addresses.some(({ address, family }) =>
      family === 4
        ? nonPublic.check(address, "ipv4")
        : !globalIPv6.check(address, "ipv6") || nonPublic.check(address, "ipv6")
    )) {
      return callback(new Error("MCP OAuth hostname has a non-public address or no address"), "", 0);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

const dispatcher = new Agent({ connect: { lookup: lookupPublic } });

export const fetchPublicMcpOAuth: typeof fetch = (input, init) => {
  const options = { ...init, dispatcher, redirect: "manual" as const };
  return globalThis.fetch(input, options);
};
