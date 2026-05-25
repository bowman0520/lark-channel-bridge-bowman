type AgentEvent = {
    type: 'system';
    sessionId?: string;
    cwd?: string;
    model?: string;
} | {
    type: 'text';
    delta: string;
} | {
    type: 'thinking';
    delta: string;
} | {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
} | {
    type: 'tool_result';
    id: string;
    output: string;
    isError: boolean;
} | {
    type: 'usage';
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
} | {
    type: 'done';
    sessionId?: string;
} | {
    type: 'error';
    message: string;
};

type ToolStatus = 'running' | 'done' | 'error';
interface ToolEntry {
    id: string;
    name: string;
    input: unknown;
    status: ToolStatus;
    output?: string;
}
type Block = {
    kind: 'text';
    content: string;
    streaming: boolean;
} | {
    kind: 'tool';
    tool: ToolEntry;
};
type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;
type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';
interface RunState {
    blocks: Block[];
    reasoning: {
        content: string;
        active: boolean;
    };
    footer: FooterStatus;
    terminal: Terminal;
    errorMsg?: string;
    /** Set when terminal === 'idle_timeout' — how long claude was idle before
     * the watchdog gave up (so the message can say "N 分钟无响应"). */
    idleTimeoutMinutes?: number;
}
declare const initialState: RunState;
declare function reduce(state: RunState, evt: AgentEvent): RunState;
declare function markInterrupted(state: RunState): RunState;
declare function finalizeIfRunning(state: RunState): RunState;

declare function renderCard(state: RunState): object;

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each (no body)
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
declare function renderText(state: RunState): string;

export { type Block, type FooterStatus, type RunState, type Terminal, type ToolEntry, type ToolStatus, finalizeIfRunning, initialState, markInterrupted, reduce, renderCard, renderText };
