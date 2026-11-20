export interface FakeSites {
  state: { signedIn: { claude: boolean; chatgpt: boolean }; requests: string[]; limitOnce: Set<string>; touched: number; claudeParents: string[] }
  handle(service: 'claude' | 'chatgpt', path: string, headers?: Record<string, string>, method?: string, body?: string): { status: number; body: string; contentType?: string; chunks?: string[] }
  addAnswer(service: 'claude' | 'chatgpt', text: string): void
  chatgptChats: Record<string, any>
  claudeChats: Record<string, any>
}
export function makeSites(): FakeSites
export function serveSite(sites: FakeSites, service: 'claude' | 'chatgpt'): Promise<{ origin: string; close(): Promise<void> }>
