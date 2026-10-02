export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function zipName(productName: string, version: string): string;
export function distNames(productName: string, version: string): { dmg: string; zip: string };
export function zipVersion(name: string): string | null;
export function zipsToPrune(names: string[], keep?: number): string[];
export function latestMacYml(info: {
  version: string;
  file: string;
  sha512: string;
  size: number;
  releaseDate: string;
}): string;
