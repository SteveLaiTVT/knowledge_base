import fs from "node:fs";
import path from "node:path";

export function checkWorkspaceAccess(workspace: string | undefined): boolean {
    if (workspace == undefined || workspace.trim().length === 0) {
        return false;
    }

    const resolvedWorkspace = path.resolve(workspace);

    try {
        const stat = fs.statSync(resolvedWorkspace);

        if (!stat.isDirectory()) {
            return false;
        }

        fs.accessSync(resolvedWorkspace, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);

        return true;
    } catch {
        return false;
    }
}
