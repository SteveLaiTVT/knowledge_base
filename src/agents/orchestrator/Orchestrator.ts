import { checkWorkspaceAccess } from "../../tools/PermissionUtility.js";
import { Codex } from "@openai/codex-sdk";

export class Orchestrator {
    private codexClient: Codex;

    // 在这个构造函数中参考 Android 的二进制权限设置，通过 flag 来判断
    public constructor(
        _permission: number,
        _name: string,
        _workspace: string | undefined = process.env.WORKSPACE,
    ) {
        // 判断能否获取 workspace读写权限
        const hasPermission = checkWorkspaceAccess(_workspace);
        if (!hasPermission) {
            throw new Error("No permission to read workspace");
        }
        this.codexClient = new Codex({
            config: {
                show_raw_agent_reasoning: true,
                sandbox_workspace_write: { network_access: true },
            },
        });
    }
}
