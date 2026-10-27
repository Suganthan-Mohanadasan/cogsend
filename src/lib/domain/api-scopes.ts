export const SCOPE_READ = 'read';
export const SCOPE_WRITE = 'write';
export const ALL_SCOPES = ['draft', 'approve_schedule'] as const;
export type ApiScope = 'read' | 'write' | (typeof ALL_SCOPES)[number];
export function parseApiScopes(raw: string | null | undefined): ApiScope[] {
	if (raw == null) return ['draft'];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return [
			...new Set(
				parsed.filter((s): s is ApiScope =>
					['read', 'write', 'draft', 'approve_schedule'].includes(s)
				)
			)
		];
	} catch {
		return [];
	}
}
export function hasApiScope(scopes: ApiScope[] | null | undefined, scope: ApiScope): boolean {
	if (!scopes) return false;
	if (scopes.includes(scope)) return true;
	if (scope === 'read')
		return scopes.some((s) => ['draft', 'write', 'approve_schedule'].includes(s));
	if (scope === 'write' || scope === 'draft')
		return scopes.includes('draft') || scopes.includes('write');
	return false;
}
export function normalizeApiScopes(input: unknown): ApiScope[] {
	if (input === undefined) return ['draft'];
	if (
		!Array.isArray(input) ||
		!input.length ||
		input.some((s) => !['draft', 'approve_schedule', 'read'].includes(s))
	)
		throw Object.assign(new Error('Use draft, approve_schedule or read scopes'), { status: 400 });
	return [...new Set(input)] as ApiScope[];
}
