export interface SpecialPurposeAddressRow {
  readonly addressBlocks: readonly string[];
  readonly name: string;
  readonly globallyReachable: boolean;
}

export type IpVersion = 4 | 6;

export interface FetchAddressClassification {
  readonly version: IpVersion;
  readonly globallyReachable: boolean;
  readonly matchedRange: string | null;
  readonly matchedName: string | null;
}
