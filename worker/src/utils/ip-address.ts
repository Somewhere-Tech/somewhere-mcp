import type {
  FetchAddressClassification,
  SpecialPurposeAddressRow,
} from '../types/ip-address';

/**
 * IANA IPv4 Special-Purpose Address Registry, last updated 2025-10-09.
 * Blank and N/A Globally Reachable cells are fail-closed as false.
 */
export const IPV4_SPECIAL_PURPOSE_REGISTRY: readonly SpecialPurposeAddressRow[] = [
  { addressBlocks: ['0.0.0.0/8'], name: 'This network', globallyReachable: false },
  { addressBlocks: ['0.0.0.0/32'], name: 'This host on this network', globallyReachable: false },
  { addressBlocks: ['10.0.0.0/8'], name: 'Private-Use', globallyReachable: false },
  { addressBlocks: ['100.64.0.0/10'], name: 'Shared Address Space', globallyReachable: false },
  { addressBlocks: ['127.0.0.0/8'], name: 'Loopback', globallyReachable: false },
  { addressBlocks: ['169.254.0.0/16'], name: 'Link Local', globallyReachable: false },
  { addressBlocks: ['172.16.0.0/12'], name: 'Private-Use', globallyReachable: false },
  { addressBlocks: ['192.0.0.0/24'], name: 'IETF Protocol Assignments', globallyReachable: false },
  { addressBlocks: ['192.0.0.0/29'], name: 'IPv4 Service Continuity Prefix', globallyReachable: false },
  { addressBlocks: ['192.0.0.8/32'], name: 'IPv4 dummy address', globallyReachable: false },
  { addressBlocks: ['192.0.0.9/32'], name: 'Port Control Protocol Anycast', globallyReachable: true },
  { addressBlocks: ['192.0.0.10/32'], name: 'Traversal Using Relays around NAT Anycast', globallyReachable: true },
  { addressBlocks: ['192.0.0.170/32', '192.0.0.171/32'], name: 'NAT64/DNS64 Discovery', globallyReachable: false },
  { addressBlocks: ['192.0.2.0/24'], name: 'Documentation (TEST-NET-1)', globallyReachable: false },
  { addressBlocks: ['192.31.196.0/24'], name: 'AS112-v4', globallyReachable: true },
  { addressBlocks: ['192.52.193.0/24'], name: 'AMT', globallyReachable: true },
  { addressBlocks: ['192.88.99.0/24'], name: 'Deprecated (6to4 Relay Anycast)', globallyReachable: false },
  { addressBlocks: ['192.88.99.2/32'], name: '6a44-relay anycast address', globallyReachable: false },
  { addressBlocks: ['192.168.0.0/16'], name: 'Private-Use', globallyReachable: false },
  { addressBlocks: ['192.175.48.0/24'], name: 'Direct Delegation AS112 Service', globallyReachable: true },
  { addressBlocks: ['198.18.0.0/15'], name: 'Benchmarking', globallyReachable: false },
  { addressBlocks: ['198.51.100.0/24'], name: 'Documentation (TEST-NET-2)', globallyReachable: false },
  { addressBlocks: ['203.0.113.0/24'], name: 'Documentation (TEST-NET-3)', globallyReachable: false },
  { addressBlocks: ['240.0.0.0/4'], name: 'Reserved', globallyReachable: false },
  { addressBlocks: ['255.255.255.255/32'], name: 'Limited Broadcast', globallyReachable: false },
];

/**
 * IANA IPv6 Special-Purpose Address Registry, last updated 2025-10-09.
 * Blank and N/A Globally Reachable cells are fail-closed as false.
 */
export const IPV6_SPECIAL_PURPOSE_REGISTRY: readonly SpecialPurposeAddressRow[] = [
  { addressBlocks: ['::1/128'], name: 'Loopback Address', globallyReachable: false },
  { addressBlocks: ['::/128'], name: 'Unspecified Address', globallyReachable: false },
  { addressBlocks: ['::ffff:0:0/96'], name: 'IPv4-mapped Address', globallyReachable: false },
  { addressBlocks: ['64:ff9b::/96'], name: 'IPv4-IPv6 Translation', globallyReachable: true },
  { addressBlocks: ['64:ff9b:1::/48'], name: 'IPv4-IPv6 Translation (local use)', globallyReachable: false },
  { addressBlocks: ['100::/64'], name: 'Discard-Only Address Block', globallyReachable: false },
  { addressBlocks: ['100:0:0:1::/64'], name: 'Dummy IPv6 Prefix', globallyReachable: false },
  { addressBlocks: ['2001::/23'], name: 'IETF Protocol Assignments', globallyReachable: false },
  { addressBlocks: ['2001::/32'], name: 'TEREDO', globallyReachable: false },
  { addressBlocks: ['2001:1::1/128'], name: 'Port Control Protocol Anycast', globallyReachable: true },
  { addressBlocks: ['2001:1::2/128'], name: 'Traversal Using Relays around NAT Anycast', globallyReachable: true },
  { addressBlocks: ['2001:1::3/128'], name: 'DNS-SD Service Registration Protocol Anycast', globallyReachable: true },
  { addressBlocks: ['2001:2::/48'], name: 'Benchmarking', globallyReachable: false },
  { addressBlocks: ['2001:3::/32'], name: 'AMT', globallyReachable: true },
  { addressBlocks: ['2001:4:112::/48'], name: 'AS112-v6', globallyReachable: true },
  { addressBlocks: ['2001:10::/28'], name: 'Deprecated (previously ORCHID)', globallyReachable: false },
  { addressBlocks: ['2001:20::/28'], name: 'ORCHIDv2', globallyReachable: true },
  { addressBlocks: ['2001:30::/28'], name: 'Drone Remote ID Protocol Entity Tags Prefix', globallyReachable: true },
  { addressBlocks: ['2001:db8::/32'], name: 'Documentation', globallyReachable: false },
  { addressBlocks: ['2002::/16'], name: '6to4', globallyReachable: false },
  { addressBlocks: ['2620:4f:8000::/48'], name: 'Direct Delegation AS112 Service', globallyReachable: true },
  { addressBlocks: ['3fff::/20'], name: 'Documentation', globallyReachable: false },
  { addressBlocks: ['5f00::/16'], name: 'Segment Routing (SRv6) SIDs', globallyReachable: false },
  { addressBlocks: ['fc00::/7'], name: 'Unique-Local', globallyReachable: false },
  { addressBlocks: ['fe80::/10'], name: 'Link-Local Unicast', globallyReachable: false },
];

interface CompiledIpv4Range {
  readonly network: number;
  readonly prefixLength: number;
  readonly globallyReachable: boolean;
  readonly addressBlock: string;
  readonly name: string;
}

interface CompiledIpv6Range {
  readonly network: readonly number[];
  readonly prefixLength: number;
  readonly globallyReachable: boolean;
  readonly addressBlock: string;
  readonly name: string;
}

/** inet_aton-compatible parsing, matching WHATWG/OS numeric-host handling. */
export function parseIPv4Address(host: string): number | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    let value: number;
    if (/^0x[0-9a-f]+$/i.test(part)) value = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part, 8);
    else if (/^(?:0|[1-9][0-9]*)$/.test(part)) value = parseInt(part, 10);
    else return null;
    if (!Number.isFinite(value) || value < 0) return null;
    nums.push(value);
  }
  switch (nums.length) {
    case 1:
      return nums[0] <= 0xffffffff ? nums[0] >>> 0 : null;
    case 2:
      return nums[0] <= 0xff && nums[1] <= 0xffffff
        ? ((nums[0] << 24) | nums[1]) >>> 0
        : null;
    case 3:
      return nums[0] <= 0xff && nums[1] <= 0xff && nums[2] <= 0xffff
        ? ((nums[0] << 24) | (nums[1] << 16) | nums[2]) >>> 0
        : null;
    case 4:
      return nums.every(value => value <= 0xff)
        ? ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0
        : null;
    default:
      return null;
  }
}

/** Parse an IPv6 literal into eight 16-bit groups. */
export function parseIPv6Address(host: string): number[] | null {
  let input = host;
  const zoneIndex = input.indexOf('%');
  if (zoneIndex !== -1) input = input.slice(0, zoneIndex);
  if (input.length === 0) return null;
  const halves = input.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const parts = side.split(':');
    const groups: number[] = [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (part.includes('.')) {
        if (index !== parts.length - 1) return null;
        const segments = part.split('.');
        if (segments.length !== 4) return null;
        const bytes: number[] = [];
        for (const segment of segments) {
          if (!/^(?:0|[1-9][0-9]{0,2})$/.test(segment)) return null;
          const value = parseInt(segment, 10);
          if (value > 255) return null;
          bytes.push(value);
        }
        groups.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
        groups.push(parseInt(part, 16));
      }
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = parseSide(input);
    return groups?.length === 8 ? groups : null;
  }
  const head = parseSide(halves[0]);
  const tail = parseSide(halves[1]);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function ipv6GroupsToBytes(groups: readonly number[]): number[] {
  return groups.flatMap(group => [(group >>> 8) & 0xff, group & 0xff]);
}

function compileIpv4Rows(rows: readonly SpecialPurposeAddressRow[]): CompiledIpv4Range[] {
  return rows.flatMap(row => row.addressBlocks.map(addressBlock => {
    const [address, prefixText] = addressBlock.split('/');
    const network = parseIPv4Address(address);
    const prefixLength = Number(prefixText);
    if (network === null || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
      throw new Error(`Invalid IPv4 registry range: ${addressBlock}`);
    }
    return { network, prefixLength, globallyReachable: row.globallyReachable, addressBlock, name: row.name };
  }));
}

function compileIpv6Rows(rows: readonly SpecialPurposeAddressRow[]): CompiledIpv6Range[] {
  return rows.flatMap(row => row.addressBlocks.map(addressBlock => {
    const [address, prefixText] = addressBlock.split('/');
    const groups = parseIPv6Address(address);
    const prefixLength = Number(prefixText);
    if (!groups || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) {
      throw new Error(`Invalid IPv6 registry range: ${addressBlock}`);
    }
    return {
      network: ipv6GroupsToBytes(groups),
      prefixLength,
      globallyReachable: row.globallyReachable,
      addressBlock,
      name: row.name,
    };
  }));
}

const IPV4_REGISTRY_RANGES = compileIpv4Rows(IPV4_SPECIAL_PURPOSE_REGISTRY);
const IPV6_REGISTRY_RANGES = compileIpv6Rows(IPV6_SPECIAL_PURPOSE_REGISTRY);

// Multicast and deprecated site-local ranges are outside the two special-
// purpose registries but are not valid public unicast fetch destinations.
const IPV4_NON_UNICAST_RANGES = compileIpv4Rows([
  { addressBlocks: ['224.0.0.0/4'], name: 'Multicast', globallyReachable: false },
]);
const IPV6_NON_UNICAST_RANGES = compileIpv6Rows([
  { addressBlocks: ['::/96'], name: 'IPv4-compatible', globallyReachable: false },
  { addressBlocks: ['fec0::/10'], name: 'Deprecated Site-Local', globallyReachable: false },
  { addressBlocks: ['ff00::/8'], name: 'Multicast', globallyReachable: false },
]);

const IPV4_FETCH_RANGES = [...IPV4_REGISTRY_RANGES, ...IPV4_NON_UNICAST_RANGES];
const IPV6_FETCH_RANGES = [...IPV6_REGISTRY_RANGES, ...IPV6_NON_UNICAST_RANGES];

function ipv4PrefixMatches(address: number, network: number, prefixLength: number): boolean {
  if (prefixLength === 0) return true;
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  return (address & mask) >>> 0 === (network & mask) >>> 0;
}

function ipv6PrefixMatches(address: readonly number[], network: readonly number[], prefixLength: number): boolean {
  const fullBytes = Math.floor(prefixLength / 8);
  for (let index = 0; index < fullBytes; index++) {
    if (address[index] !== network[index]) return false;
  }
  const remainingBits = prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[fullBytes] & mask) === (network[fullBytes] & mask);
}

function classifyIpv4(address: number): FetchAddressClassification {
  let match: CompiledIpv4Range | null = null;
  for (const range of IPV4_FETCH_RANGES) {
    if (range.prefixLength <= (match?.prefixLength ?? -1)) continue;
    if (ipv4PrefixMatches(address, range.network, range.prefixLength)) match = range;
  }
  return {
    version: 4,
    globallyReachable: match?.globallyReachable ?? true,
    matchedRange: match?.addressBlock ?? null,
    matchedName: match?.name ?? null,
  };
}

function classifyIpv6(groups: readonly number[]): FetchAddressClassification {
  const mappedIpv4 = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
  const nat64Ipv4 = groups[0] === 0x64 && groups[1] === 0xff9b
    && groups.slice(2, 6).every(group => group === 0);
  if (mappedIpv4 || nat64Ipv4) {
    const embedded = ((groups[6] << 16) | groups[7]) >>> 0;
    const normalized = classifyIpv4(embedded);
    return {
      version: 6,
      globallyReachable: normalized.globallyReachable,
      matchedRange: normalized.matchedRange,
      matchedName: normalized.matchedName,
    };
  }

  const bytes = ipv6GroupsToBytes(groups);
  let match: CompiledIpv6Range | null = null;
  for (const range of IPV6_FETCH_RANGES) {
    if (range.prefixLength <= (match?.prefixLength ?? -1)) continue;
    if (ipv6PrefixMatches(bytes, range.network, range.prefixLength)) match = range;
  }
  return {
    version: 6,
    globallyReachable: match?.globallyReachable ?? true,
    matchedRange: match?.addressBlock ?? null,
    matchedName: match?.name ?? null,
  };
}

/** Null means the input is not an IP literal. */
export function classifyAddressForFetch(host: string): FetchAddressClassification | null {
  const unbracketed = host.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = parseIPv4Address(unbracketed);
  if (ipv4 !== null) return classifyIpv4(ipv4);
  if (!unbracketed.includes(':')) return null;
  const ipv6 = parseIPv6Address(unbracketed);
  return ipv6 ? classifyIpv6(ipv6) : null;
}

export function isIpLiteral(host: string): boolean {
  return classifyAddressForFetch(host) !== null;
}

export const IPV4_FETCH_RANGES_JSON = JSON.stringify(
  IPV4_FETCH_RANGES.map(range => [range.network, range.prefixLength, range.globallyReachable]),
);

export const IPV6_FETCH_RANGES_JSON = JSON.stringify(
  IPV6_FETCH_RANGES.map(range => [range.network, range.prefixLength, range.globallyReachable]),
);
