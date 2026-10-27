import { vi } from 'vitest';

// These upstream suites exercise provider protocols and scheduler mechanics in isolation.
// approval-gate.test.ts exercises the complete publishing policy with real SQLite and fake HTTP.
vi.mock('#lib/server/approval-gate.js', () => ({
	audit: async () => {},
	assertPublishingEnabled: async () => {},
	assertDispatchAllowed: async () => {},
	checkTargetApproval: async () => ({ approval: {}, snapshot: { content: null } }),
	checkBeforePlatformCall: async () => {},
	reserveDispatch: async () => {},
	requireApproval: async () => ({ approval: {}, snapshot: { content: null } })
}));
