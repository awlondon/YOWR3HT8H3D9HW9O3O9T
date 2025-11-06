export const KB_SCHEMA_VERSION = 1;

export type EdgeBlock = {
  tokenId: number;
  part: number;
  count: number;
  neighbor: Uint32Array;
  type: Uint16Array;
  weight: Uint32Array;
  lastSeen: Uint32Array;
  flags?: Uint8Array;
};
