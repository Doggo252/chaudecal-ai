export interface MockOpenAI {
  port: number
  baseUrl: string
  requests: any[]
  close(): Promise<void>
}
export function startMockOpenAI(options?: { models?: string[]; delayMs?: number }): Promise<MockOpenAI>
