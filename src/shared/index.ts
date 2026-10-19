// Shared types and Zod schemas used across the main, preload, and renderer
// process contexts. Concrete contracts (IPC channels, domain types) are added
// in later tasks; this barrel establishes the shared compiler surface.

export * from './secrets';
export * from './catalog';
export * from './connector';
export * from './mcp';
export * from './chat-contract';
export * from './attachments';
