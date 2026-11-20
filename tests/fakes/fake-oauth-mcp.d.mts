export function startOAuthMcp(options?: { expiresIn?: number }): Promise<{ url: string; origin: string; state: { calls: string[]; issued: number; tokens: Set<string> }; close(): Promise<void> }>
