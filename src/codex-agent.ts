import {Codex} from "@openai/codex-sdk";

export interface RunOptions {
    cwd?: string;
}

export class MinimalCodexAgent {
    private codex: Codex;
    private thread: Awaited<ReturnType<Codex["startThread"]>> | null = null;

    constructor() {
        this.codex = new Codex({
            config: {
                show_raw_agent_reasoning: true,
                sandbox_workspace_write: {network_access: true},
            }
        });
    }

    async init() {
        if (!this.thread) {
            this.thread = this.codex.startThread(
                {
                    skipGitRepoCheck: true,
                }
            );
        }
        return this.thread;
    }

    async run(prompt: string): Promise<unknown> {
        const thread = await this.init();
        return await thread.run(prompt);
    }

    async continue(prompt: string): Promise<unknown> {
        if (!this.thread) {
            throw new Error("Thread not initialized. Call run() first.");
        }
        return await this.thread.run(prompt);
    }
}
