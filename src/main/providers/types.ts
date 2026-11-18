import type { ApprovalDecision, ProviderStatus, RunEvent, RunMode } from '@shared/types'
import type { ChatTurn } from '@shared/context'

export interface RunRequest {
  /** Text for providers that keep their own session. */
  prompt: string
  /** Full message list for stateless providers. */
  messages?: ChatTurn[]
  /** Shared instructions and memory, applied as system text. */
  system: string
  model: string
  mode: RunMode
  /** Folder the assistant works in. */
  cwd: string
  /** Provider session to continue, if any. */
  sessionId?: string
  /** Do not keep a session for this run (compare mode). */
  ephemeral?: boolean
  /** Extra permission rules granted by the user for this run (Claude syntax). */
  allow?: string[]
}

export interface RunHandle {
  /** Resolves when the run has ended, whatever the outcome. */
  done: Promise<void>
  stop(): void
  respondApproval?(id: string, decision: ApprovalDecision): void
}

export interface Provider {
  status(): Promise<ProviderStatus>
  run(request: RunRequest, emit: (event: RunEvent) => void): RunHandle
  dispose?(): void
}

export function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`
}
