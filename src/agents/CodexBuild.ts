import { checkPermission } from "../tools/PermissionUtility.js";

export class CodexBuild {
    // 在这个构造函数中参考 Android 的二进制权限设置，通过 flag 来判断
    public constructor(
        permission: number,
        _name: string,
        _workspace: string | undefined = process.env.WORKSPACE,
    ) {
        // 判断能否获取 workspace读写权限
        const hasPermission = checkPermission(permission);
        if (!hasPermission) {
            throw new Error("No permission to read workspace");
        }
    }
}
