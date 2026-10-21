// Pure, total status derivation for catalog entries. Given a `CatalogEntry`
// and the result of PATH discovery (the binary found on PATH, or `undefined`),
// `deriveStatus` returns exactly one of the three `CatalogStatus` values and
// never throws. It holds no knowledge of how discovery works — the discovered
// binary is passed in as a plain `string | undefined`, so this module stays
// decoupled from the concrete `CliDiscoveryService` / `CliEnvironment` seam.
//
// The rule encodes Requirements 2.2, 2.3, 2.4 (design Property 1 — status
// derivation is total and correct):
//   - `installed`     when discovery found a candidate binary (discoveredBinary
//                     !== undefined).
//   - `available`     when none was found AND the install method is confirmed
//                     (its kind is not `unconfigured`) AND there are candidate
//                     names to search.
//   - `unconfigured`  when the entry has no candidate binary names OR its
//                     install method is `unconfigured`.

import type { CatalogEntry, CatalogStatus } from '../../shared/catalog';

/**
 * Derive a catalog entry's status from the discovery result.
 *
 * Total and pure: every input maps to exactly one of `installed` /
 * `available` / `unconfigured`, and the function never throws.
 *
 * @param entry The catalog entry being evaluated.
 * @param discoveredBinary The binary discovered on PATH for this entry, or
 *   `undefined` when discovery found none (including the empty-candidate case).
 *   The caller (the catalog) carries the discovered binary into the
 *   `CatalogEntryView`; this function only reports the derived status.
 */
export function deriveStatus(
  entry: CatalogEntry,
  discoveredBinary: string | undefined,
): CatalogStatus {
  // A discovered binary always means `installed`, regardless of configuration:
  // the tool is genuinely on PATH (Requirement 2.2).
  if (discoveredBinary !== undefined) {
    return 'installed';
  }

  // No binary found. The entry is `unconfigured` when it has nothing to search
  // for (empty candidate names) or no confirmed install method (Requirement
  // 2.4). Otherwise it is a confirmed-but-missing entry: `available`
  // (Requirement 2.3).
  if (
    entry.candidateBinaryNames.length === 0 ||
    entry.installMethod.kind === 'unconfigured'
  ) {
    return 'unconfigured';
  }

  return 'available';
}
