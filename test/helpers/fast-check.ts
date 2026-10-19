// Barrel re-export of fast-check plus shared arbitraries used across the
// property-based tests (P1–P8). Concrete arbitraries (task states, transition
// sequences, secret placeholders, ingested payloads) are added alongside the
// subsystems they exercise.
export * as fc from 'fast-check';
