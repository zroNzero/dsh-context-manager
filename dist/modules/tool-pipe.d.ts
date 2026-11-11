/**
 * ToolPipe —— 工具结果数据平面（v2.0 正式版）。
 *
 * 工具输出落盘后只传引用（pipe-xxxxxxxx），模型可通过 read_ref 元工具按需取回。
 * ref 索引写入 `<spillDir>/.pipe-index.json`，跨进程可用。
 */
export declare class ToolPipe {
    private readonly spillDir;
    private readonly indexPath;
    private readonly entries;
    constructor(spillDir: string);
    private load;
    private persist;
    refForFile(filePath: string): string;
    publishFile(filePath: string): {
        ref: string;
        bytes: number;
    };
    resolve(ref: string): {
        ok: boolean;
        text: string;
        bytes: number;
    };
    size(): number;
}
