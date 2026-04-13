import fs from "node:fs/promises";
import path from "node:path";

export interface DocumentBlock {
    blockId: string;
    chapterId: string;
    chapterTitle: string;
    page: number | null;
    text: string;
}

export interface DocumentChapter {
    chapterId: string;
    title: string;
    summary: string;
    blockIds: string[];
}

export interface WorkspaceDocument {
    docId: string;
    title: string;
    docType: "markdown";
    summary: string;
    sourcePath: string;
    categoryId: string;
}

export interface ParsedMarkdownDocument extends WorkspaceDocument {
    chapters: DocumentChapter[];
    blocks: DocumentBlock[];
}

const PAGE_HEADING_PATTERN = /^##\s+Page\s+(\d+)\s*$/u;

function normalizeDocId(filePath: string, workspace: string): string {
    return path.relative(workspace, filePath).split(path.sep).join("/");
}

function createSlug(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "");

    return normalized.length > 0 ? normalized : "section";
}

function summarizeText(text: string, maxLength: number = 280): string {
    const normalized = text.replace(/\s+/gu, " ").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

async function collectMarkdownFiles(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        if (entry.name === ".codex-kb" || entry.name === "_incoming") {
            continue;
        }

        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectMarkdownFiles(fullPath)));
            continue;
        }

        if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
            files.push(fullPath);
        }
    }

    return files;
}

export async function listWorkspaceDocuments(workspace: string): Promise<WorkspaceDocument[]> {
    const files = await collectMarkdownFiles(workspace);
    const documents = await Promise.all(
        files.map((filePath) => parseMarkdownDocument(workspace, filePath)),
    );

    return documents.map(({ docId, title, summary, sourcePath, categoryId }) => ({
        docId,
        title,
        docType: "markdown",
        summary,
        sourcePath,
        categoryId,
    }));
}

export async function parseMarkdownDocument(
    workspace: string,
    filePath: string,
): Promise<ParsedMarkdownDocument> {
    const sourcePath = path.resolve(filePath);
    const docId = normalizeDocId(sourcePath, workspace);
    const content = await fs.readFile(sourcePath, "utf-8");
    const lines = content.split(/\r?\n/u);
    const defaultTitle = path.parse(sourcePath).name;
    const firstHeading = lines.find((line) => line.startsWith("# "));
    const title = firstHeading?.slice(2).trim() || defaultTitle;
    const categoryDirectory = path.posix.dirname(docId);
    const categoryId = categoryDirectory === "." ? "default" : categoryDirectory.split("/")[0];

    const blocks: DocumentBlock[] = [];
    const chapterTitles = new Map<string, string>();
    const chapterBlockIds = new Map<string, string[]>();

    let activeChapterId = "overview";
    let activeChapterTitle = "Overview";
    let activePage: number | null = null;
    let paragraphLines: string[] = [];
    let blockIndex = 0;

    const flushParagraph = (): void => {
        const text = paragraphLines.join(" ").replace(/\s+/gu, " ").trim();
        if (text.length === 0) {
            paragraphLines = [];
            return;
        }

        blockIndex += 1;
        const blockId = `${activeChapterId}-block-${blockIndex}`;
        blocks.push({
            blockId,
            chapterId: activeChapterId,
            chapterTitle: activeChapterTitle,
            page: activePage,
            text,
        });

        const blockIds = chapterBlockIds.get(activeChapterId) ?? [];
        blockIds.push(blockId);
        chapterBlockIds.set(activeChapterId, blockIds);
        chapterTitles.set(activeChapterId, activeChapterTitle);
        paragraphLines = [];
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            flushParagraph();
            continue;
        }

        const pageMatch = trimmed.match(PAGE_HEADING_PATTERN);
        if (pageMatch != null) {
            flushParagraph();
            activePage = Number.parseInt(pageMatch[1], 10);
            activeChapterId = `page-${activePage}`;
            activeChapterTitle = `Page ${activePage}`;
            chapterTitles.set(activeChapterId, activeChapterTitle);
            continue;
        }

        const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/u);
        if (headingMatch != null) {
            flushParagraph();
            const depth = headingMatch[1].length;
            const headingTitle = headingMatch[2].trim();
            if (depth <= 2) {
                activeChapterId = createSlug(headingTitle);
                activeChapterTitle = headingTitle;
                chapterTitles.set(activeChapterId, activeChapterTitle);
            }
            continue;
        }

        paragraphLines.push(trimmed);
    }

    flushParagraph();

    const allText = blocks.map((block) => block.text).join(" ");
    const summary = summarizeText(allText, 360);

    const chapters = [...chapterTitles.entries()].map(([chapterId, chapterTitle]) => {
        const blockIds = chapterBlockIds.get(chapterId) ?? [];
        const chapterText = blockIds
            .map((blockId) => blocks.find((block) => block.blockId === blockId)?.text ?? "")
            .join(" ");

        return {
            chapterId,
            title: chapterTitle,
            summary: summarizeText(chapterText, 220),
            blockIds,
        };
    });

    if (chapters.length === 0) {
        chapters.push({
            chapterId: activeChapterId,
            title: activeChapterTitle,
            summary,
            blockIds: blocks.map((block) => block.blockId),
        });
    }

    return {
        docId,
        title,
        docType: "markdown",
        summary,
        sourcePath,
        categoryId,
        chapters,
        blocks,
    };
}

export async function loadWorkspaceDocument(
    workspace: string,
    docId: string,
): Promise<ParsedMarkdownDocument | null> {
    const filePath = path.join(workspace, docId);
    try {
        await fs.access(filePath);
    } catch {
        return null;
    }

    return parseMarkdownDocument(workspace, filePath);
}
