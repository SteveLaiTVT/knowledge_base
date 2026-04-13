import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertWorkspaceAccess, createDirectory } from "../FileUtility.js";
import { loadWorkspaceDocument } from "../docs/markdownDocument.js";
import generateUUID from "../common/uuid.js";

export type MemoryKind = "semantic" | "episodic" | "procedural" | "task";
export type MemoryScope = "portrait" | "category" | "document" | "thread";

export interface MemoryRecord {
    id: string;
    userId: string;
    kind: MemoryKind;
    scope: MemoryScope;
    scopeId: string;
    text: string;
    keywords: string[];
    salience: number;
    confidence: number;
    reuseCount: number;
    lastAccessedAt: string;
    createdAt: string;
    updatedAt: string;
    sourceRefs: string[];
}

export interface PortraitState {
    userId: string;
    expertise: string[];
    domainFamiliarity: string[];
    answerStylePreferences: string[];
    longLivedConstraints: string[];
    summary: string;
    updatedAt: string;
}

export interface TaskState {
    threadId: string;
    goal: string;
    unresolvedItems: string[];
    sessionOverrides: string[];
    lastSummary: string;
    lastActiveCategoryHints: string[];
    lastActiveDocumentHints: string[];
    updatedAt: string;
}

export interface RetrievalReadStep {
    mode: "catalog" | "summary" | "structure" | "page_range" | "full_text_short";
    target: string;
    goal: string;
    pages: string | null;
}

export interface RetrievalPlanDocument {
    doc_id: string;
    priority: number;
    reason: string;
    read_steps: RetrievalReadStep[];
}

export interface RetrievalPlan {
    version?: string;
    intent?: {
        type?: string;
        user_goal?: string;
        answer_scope?: string;
    };
    need_clarification?: boolean;
    clarification_question?: string | null;
    strategy?: {
        approach?: string;
        notes?: string;
    };
    document_plan?: RetrievalPlanDocument[];
    stop_conditions?: string[];
    confidence?: number;
}

export interface EvidenceBlock {
    docId: string;
    blockId: string;
    categoryId: string;
    chapterId: string;
    page: number | null;
    text: string;
    citation: string;
    score: number;
}

export interface RetrievedEvidence {
    docId: string;
    categoryId: string;
    title: string;
    summary: string;
    sourcePath: string;
    blocks: EvidenceBlock[];
}

export interface CategoryMemoryView {
    userId: string;
    categoryId: string;
    semanticSummary: string;
    recurringEntities: string[];
    recurringQuestions: string[];
    recentDecisions: string[];
    hotDocuments: string[];
    recentEpisodes: MemoryRecord[];
    stable_zone: MemoryRecord[];
    hot_zone: MemoryRecord[];
    rebuildMeta: {
        lastRebuiltAt: string;
        sourceRecordCount: number;
        newestSourceUpdatedAt: string | null;
        recentArchiveCount: number;
    };
    updatedAt: string;
}

export interface DocumentMemoryView {
    userId: string;
    docId: string;
    docSummary: string;
    chapterSummaries: Array<{
        chapterId: string;
        summary: string;
    }>;
    activeChapterIds: string[];
    activeBlockIds: string[];
    relatedEdges: Array<{
        targetDocId: string;
        relation: string;
    }>;
    lastFrontier: string[];
    rebuildMeta: {
        lastRebuiltAt: string;
        sourceRecordCount: number;
        newestSourceUpdatedAt: string | null;
        sourceDocumentUpdatedAt: string | null;
    };
    updatedAt: string;
}

export interface ContextPack {
    userId: string;
    threadId: string;
    query: string;
    portraitSummary: string | null;
    taskSummary: string | null;
    categoryMemories: CategoryMemoryView[];
    documentMemories: DocumentMemoryView[];
    episodicNotes: MemoryRecord[];
    evidence: RetrievedEvidence[];
    citationInstructions: string[];
    assembledContext: string;
    loadedAt: string;
}

export interface RunArchiveEntry {
    id: string;
    userId: string;
    threadId: string;
    query: string;
    answer: string;
    citations: string[];
    plan: RetrievalPlan | null;
    evidence: RetrievedEvidence[];
    categoryIds: string[];
    documentIds: string[];
    memoryRecordIds: string[];
    createdAt: string;
}

export interface MemorySearchResult {
    portrait: PortraitState;
    taskState: TaskState;
    categoryIds: string[];
    documentIds: string[];
    categoryMemories: CategoryMemoryView[];
    documentMemories: DocumentMemoryView[];
    episodicNotes: MemoryRecord[];
}

export interface MemoryCandidateInput {
    id?: string;
    userId?: string;
    kind?: MemoryKind;
    scope?: MemoryScope;
    scopeId?: string;
    text: string;
    keywords?: string[];
    salience?: number;
    confidence?: number;
    reuseCount?: number;
    lastAccessedAt?: string;
    createdAt?: string;
    updatedAt?: string;
    sourceRefs?: string[];
}

const DEFAULT_USER_ID = "local";
const DEFAULT_THREAD_ID = "default";
const CATEGORY_HOT_ZONE_LIMIT = 12;
const CATEGORY_RECENT_EPISODE_SCAN_LIMIT = 20;
const CATEGORY_RECENT_EPISODE_LIMIT = 6;
const DOCUMENT_ACTIVE_BLOCK_LIMIT = 24;
const CONTINUATION_EPISODE_LIMIT = 4;

const STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "how",
    "if",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "their",
    "this",
    "to",
    "was",
    "we",
    "what",
    "when",
    "which",
    "with",
    "you",
    "your",
]);

interface PortraitStore {
    portraits: Record<string, PortraitState>;
}

interface CacheStore<TValue> {
    entries: Record<string, TValue>;
}

function createDefaultPortrait(userId: string = DEFAULT_USER_ID): PortraitState {
    return {
        userId,
        expertise: [],
        domainFamiliarity: [],
        answerStylePreferences: [],
        longLivedConstraints: [],
        summary: "",
        updatedAt: "",
    };
}

function createDefaultTaskState(threadId: string = DEFAULT_THREAD_ID): TaskState {
    return {
        threadId,
        goal: "",
        unresolvedItems: [],
        sessionOverrides: [],
        lastSummary: "",
        lastActiveCategoryHints: [],
        lastActiveDocumentHints: [],
        updatedAt: "",
    };
}

function toIsoDate(value: Date | string | undefined = undefined): string {
    return value instanceof Date ? value.toISOString() : (value ?? new Date().toISOString());
}

function clamp(value: number, minValue: number, maxValue: number): number {
    return Math.min(maxValue, Math.max(minValue, value));
}

function normalizeStringArray(values: string[] | undefined): string[] {
    if (values == undefined) {
        return [];
    }

    return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function tokenize(text: string): string[] {
    return [
        ...new Set(
            text
                .toLowerCase()
                .split(/[^a-z0-9]+/u)
                .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
        ),
    ];
}

function summarizeText(text: string, maxLength: number = 280): string {
    const normalized = text.replace(/\s+/gu, " ").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function combineSummaryTexts(texts: string[], maxLength: number = 420): string {
    const uniqueTexts = [
        ...new Set(texts.map((text) => text.trim()).filter((text) => text.length > 0)),
    ];
    let combined = "";

    for (const text of uniqueTexts) {
        const candidate =
            combined.length === 0 ? summarizeText(text, maxLength) : `${combined} ${text}`;
        if (candidate.length > maxLength) {
            break;
        }

        combined = candidate;
    }

    return summarizeText(combined, maxLength);
}

function stableHash(value: string): string {
    return crypto.createHash("sha1").update(value).digest("hex");
}

function encodeIdForFile(id: string): string {
    return encodeURIComponent(id);
}

function inferCategoryIdFromDocId(docId: string): string {
    const normalized = docId.split(path.sep).join("/");
    const [categoryId] = normalized.split("/");
    return categoryId != undefined && categoryId.length > 0 ? categoryId : "default";
}

function isContinuationQuery(query: string): boolean {
    return /\b(continue|same|again|follow[- ]?up|previous|earlier|that one|those|as before)\b/iu.test(
        query,
    );
}

function buildPortraitSummary(portrait: PortraitState): string | null {
    const parts = [
        portrait.summary,
        portrait.expertise.length > 0 ? `Expertise: ${portrait.expertise.join(", ")}` : "",
        portrait.domainFamiliarity.length > 0
            ? `Domain familiarity: ${portrait.domainFamiliarity.join(", ")}`
            : "",
        portrait.answerStylePreferences.length > 0
            ? `Answer style: ${portrait.answerStylePreferences.join(", ")}`
            : "",
        portrait.longLivedConstraints.length > 0
            ? `Long-lived constraints: ${portrait.longLivedConstraints.join(", ")}`
            : "",
    ].filter((part) => part.length > 0);

    return parts.length > 0 ? parts.join("\n") : null;
}

function buildTaskSummary(taskState: TaskState): string | null {
    const parts = [
        taskState.goal.length > 0 ? `Goal: ${taskState.goal}` : "",
        taskState.lastSummary.length > 0 ? `Last summary: ${taskState.lastSummary}` : "",
        taskState.unresolvedItems.length > 0
            ? `Unresolved: ${taskState.unresolvedItems.join("; ")}`
            : "",
        taskState.sessionOverrides.length > 0
            ? `Session overrides: ${taskState.sessionOverrides.join("; ")}`
            : "",
    ].filter((part) => part.length > 0);

    return parts.length > 0 ? parts.join("\n") : null;
}

function scoreRecency(isoTimestamp: string): number {
    if (isoTimestamp.length === 0) {
        return 0.1;
    }

    const ageMs = Date.now() - new Date(isoTimestamp).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays <= 1) {
        return 1;
    }

    if (ageDays <= 7) {
        return 0.7;
    }

    if (ageDays <= 30) {
        return 0.4;
    }

    return 0.1;
}

function scoreRelevance(queryTokens: string[], record: MemoryRecord): number {
    if (queryTokens.length === 0) {
        return 0.4;
    }

    const haystack = new Set([...record.keywords, ...tokenize(record.text)]);
    const matches = queryTokens.filter((token) => haystack.has(token)).length;
    return clamp(matches / queryTokens.length, 0, 1);
}

function scoreMemoryRecord(record: MemoryRecord, relevance: number): number {
    const recency = scoreRecency(record.updatedAt || record.createdAt);
    const reuseCountNormalized = clamp(record.reuseCount / 10, 0, 1);

    return (
        0.35 * relevance +
        0.25 * clamp(record.salience, 0, 1) +
        0.15 * recency +
        0.15 * reuseCountNormalized +
        0.1 * clamp(record.confidence, 0, 1)
    );
}

function buildCitationInstructions(): string[] {
    return [
        "Use source-backed citations from evidence blocks whenever you make a factual claim.",
        "Use memory as guidance for continuity and preferences, not as stronger evidence than the documents.",
        "Do not claim persistent memory unless it appears in the provided context pack.",
    ];
}

function createFallbackRecord(
    userId: string,
    threadId: string,
    query: string,
    answer: string,
    sourceRefs: string[],
): MemoryRecord {
    const createdAt = toIsoDate();

    return {
        id: generateUUID(),
        userId,
        kind: "episodic",
        scope: "thread",
        scopeId: threadId,
        text: summarizeText(`User asked: ${query}\nAnswer summary: ${answer}`, 320),
        keywords: tokenize(`${query} ${answer}`),
        salience: 0.55,
        confidence: 0.5,
        reuseCount: 0,
        lastAccessedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
        sourceRefs,
    };
}

function normalizeMemoryRecord(candidate: MemoryCandidateInput, userId: string): MemoryRecord {
    const createdAt = toIsoDate(candidate.createdAt);
    const updatedAt = toIsoDate(candidate.updatedAt ?? createdAt);
    const scope = candidate.scope ?? "thread";
    const scopeId = candidate.scopeId ?? DEFAULT_THREAD_ID;

    return {
        id: candidate.id ?? generateUUID(),
        userId: candidate.userId ?? userId,
        kind: candidate.kind ?? "episodic",
        scope,
        scopeId,
        text: summarizeText(candidate.text, 500),
        keywords: normalizeStringArray(candidate.keywords ?? tokenize(candidate.text)),
        salience: clamp(candidate.salience ?? 0.5, 0, 1),
        confidence: clamp(candidate.confidence ?? 0.5, 0, 1),
        reuseCount: Math.max(0, candidate.reuseCount ?? 0),
        lastAccessedAt: toIsoDate(candidate.lastAccessedAt ?? updatedAt),
        createdAt,
        updatedAt,
        sourceRefs: normalizeStringArray(candidate.sourceRefs),
    };
}

function buildKbPaths(kbDir?: string): {
    workspaceRoot: string;
    kbRoot: string;
    archiveRoot: string;
    memoryRecordsFile: string;
    portraitFile: string;
    categoriesDir: string;
    documentsDir: string;
    threadsDir: string;
    queryPlanCacheFile: string;
    frontiersCacheFile: string;
    contextPacksCacheFile: string;
} {
    const workspaceRoot = assertWorkspaceAccess(kbDir);
    const kbRoot = createDirectory(path.join(workspaceRoot, ".codex-kb"));
    const archiveRoot = createDirectory(path.join(kbRoot, "archive", "runs"));
    const memoryDir = createDirectory(path.join(kbRoot, "memory"));
    const viewsDir = createDirectory(path.join(kbRoot, "views"));
    const cacheDir = createDirectory(path.join(kbRoot, "cache"));

    return {
        workspaceRoot,
        kbRoot,
        archiveRoot,
        memoryRecordsFile: path.join(memoryDir, "records.jsonl"),
        portraitFile: path.join(viewsDir, "portrait.json"),
        categoriesDir: createDirectory(path.join(viewsDir, "categories")),
        documentsDir: createDirectory(path.join(viewsDir, "documents")),
        threadsDir: createDirectory(path.join(kbRoot, "threads")),
        queryPlanCacheFile: path.join(cacheDir, "query-plans.json"),
        frontiersCacheFile: path.join(cacheDir, "frontiers.json"),
        contextPacksCacheFile: path.join(cacheDir, "context-packs.json"),
    };
}

async function readJsonFile<TValue>(filePath: string, fallback: TValue): Promise<TValue> {
    try {
        const content = await fs.readFile(filePath, "utf-8");
        return JSON.parse(content) as TValue;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return fallback;
        }

        throw error;
    }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function appendJsonl(filePath: string, values: unknown[]): Promise<void> {
    if (values.length === 0) {
        return;
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const content = `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
    await fs.appendFile(filePath, content, "utf-8");
}

async function readJsonlRecords(filePath: string): Promise<MemoryRecord[]> {
    try {
        const content = await fs.readFile(filePath, "utf-8");
        const byId = new Map<string, MemoryRecord>();

        for (const line of content.split(/\r?\n/u)) {
            if (line.trim().length === 0) {
                continue;
            }

            const record = JSON.parse(line) as MemoryRecord;
            byId.set(record.id, record);
        }

        return [...byId.values()].sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }

        throw error;
    }
}

async function readArchiveFiles(directory: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const files: string[] = [];

        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                files.push(...(await readArchiveFiles(fullPath)));
            } else if (entry.isFile() && entry.name.endsWith(".json")) {
                files.push(fullPath);
            }
        }

        return files;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }

        throw error;
    }
}

async function loadRunArchives(kbDir?: string): Promise<RunArchiveEntry[]> {
    const paths = buildKbPaths(kbDir);
    const files = await readArchiveFiles(paths.archiveRoot);
    const entries = await Promise.all(
        files.map(
            async (filePath) => JSON.parse(await fs.readFile(filePath, "utf-8")) as RunArchiveEntry,
        ),
    );

    return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function writeCacheEntry<TValue>(
    filePath: string,
    key: string,
    value: TValue,
): Promise<void> {
    const store = await readJsonFile<CacheStore<TValue>>(filePath, { entries: {} });
    store.entries[key] = value;
    await writeJsonFile(filePath, store);
}

function buildContextCacheKey(
    userId: string,
    threadId: string,
    query: string,
    documentIds: string[],
): string {
    return stableHash(`${userId}:${threadId}:${query}:${documentIds.join(",")}`);
}

function collectDocumentIds(
    plan: RetrievalPlan | undefined,
    evidence: RetrievedEvidence[],
    taskState: TaskState,
): string[] {
    const fromPlan = plan?.document_plan?.map((document) => document.doc_id) ?? [];
    const fromEvidence = evidence.map((entry) => entry.docId);
    const fromTask = taskState.lastActiveDocumentHints;

    return [
        ...new Set([...fromPlan, ...fromEvidence, ...fromTask].filter((value) => value.length > 0)),
    ];
}

function collectCategoryIds(
    documentIds: string[],
    evidence: RetrievedEvidence[],
    taskState: TaskState,
): string[] {
    const fromEvidence = evidence.map((entry) => entry.categoryId);
    const fromDocuments = documentIds.map((docId) => inferCategoryIdFromDocId(docId));
    const fromTask = taskState.lastActiveCategoryHints;

    return [
        ...new Set(
            [...fromEvidence, ...fromDocuments, ...fromTask].filter((value) => value.length > 0),
        ),
    ];
}

function buildArchivePseudoRecord(
    entry: RunArchiveEntry,
    scope: MemoryScope,
    scopeId: string,
): MemoryRecord {
    return {
        id: `archive-${entry.id}-${scope}-${scopeId}`,
        userId: entry.userId,
        kind: "episodic",
        scope,
        scopeId,
        text: summarizeText(`Query: ${entry.query}\nAnswer: ${entry.answer}`, 320),
        keywords: tokenize(`${entry.query} ${entry.answer}`),
        salience: 0.5,
        confidence: 0.45,
        reuseCount: 0,
        lastAccessedAt: entry.createdAt,
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
        sourceRefs: entry.citations,
    };
}

function topKeywords(records: MemoryRecord[], maxCount: number = 8): string[] {
    const counts = new Map<string, number>();
    for (const record of records) {
        for (const keyword of record.keywords) {
            counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
        }
    }

    return [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, maxCount)
        .map(([keyword]) => keyword);
}

async function loadCategoryView(
    userId: string,
    categoryId: string,
    kbDir?: string,
): Promise<CategoryMemoryView | null> {
    const paths = buildKbPaths(kbDir);
    const filePath = path.join(paths.categoriesDir, `${encodeIdForFile(categoryId)}.json`);
    const view = await readJsonFile<CategoryMemoryView | null>(filePath, null);

    return view != null && view.userId === userId ? view : null;
}

async function loadDocumentView(
    userId: string,
    docId: string,
    kbDir?: string,
): Promise<DocumentMemoryView | null> {
    const paths = buildKbPaths(kbDir);
    const filePath = path.join(paths.documentsDir, `${encodeIdForFile(docId)}.json`);
    const view = await readJsonFile<DocumentMemoryView | null>(filePath, null);

    return view != null && view.userId === userId ? view : null;
}

function needsCategoryRebuild(
    view: CategoryMemoryView | null,
    relevantRecords: MemoryRecord[],
    recentArchiveCount: number,
): boolean {
    if (view == null) {
        return true;
    }

    if (view.hot_zone.length > CATEGORY_HOT_ZONE_LIMIT) {
        return true;
    }

    if (recentArchiveCount > CATEGORY_RECENT_EPISODE_SCAN_LIMIT) {
        return true;
    }

    const newestRecord = relevantRecords[relevantRecords.length - 1];
    if (newestRecord != null && newestRecord.updatedAt > view.rebuildMeta.lastRebuiltAt) {
        return true;
    }

    return false;
}

async function needsDocumentRebuild(
    view: DocumentMemoryView | null,
    docId: string,
    evidence: RetrievedEvidence[],
    kbDir?: string,
): Promise<boolean> {
    if (view == null) {
        return true;
    }

    if (view.activeBlockIds.length > DOCUMENT_ACTIVE_BLOCK_LIMIT) {
        return true;
    }

    const relevantEvidence = evidence.find((entry) => entry.docId === docId);
    if (relevantEvidence != null) {
        const incomingChapters = new Set(relevantEvidence.blocks.map((block) => block.chapterId));
        const hasChapterShift = [...incomingChapters].some(
            (chapterId) => !view.activeChapterIds.includes(chapterId),
        );
        if (hasChapterShift) {
            return true;
        }

        const hasNewBlock = relevantEvidence.blocks.some(
            (block) => !view.activeBlockIds.includes(block.blockId),
        );
        if (hasNewBlock) {
            return true;
        }
    }

    const document = await loadWorkspaceDocument(buildKbPaths(kbDir).workspaceRoot, docId);
    if (document == null) {
        return false;
    }

    const stat = await fs.stat(document.sourcePath);
    const updatedAt = stat.mtime.toISOString();
    return updatedAt > (view.rebuildMeta.sourceDocumentUpdatedAt ?? "");
}

export async function loadPortrait(
    userId: string = DEFAULT_USER_ID,
    kbDir?: string,
): Promise<PortraitState> {
    const paths = buildKbPaths(kbDir);
    const store = await readJsonFile<PortraitStore>(paths.portraitFile, { portraits: {} });
    return store.portraits[userId] ?? createDefaultPortrait(userId);
}

export async function savePortrait(
    userId: string,
    portrait: Partial<PortraitState>,
    kbDir?: string,
): Promise<PortraitState> {
    const paths = buildKbPaths(kbDir);
    const store = await readJsonFile<PortraitStore>(paths.portraitFile, { portraits: {} });
    const nextPortrait: PortraitState = {
        ...createDefaultPortrait(userId),
        ...store.portraits[userId],
        ...portrait,
        userId,
        expertise: normalizeStringArray(portrait.expertise ?? store.portraits[userId]?.expertise),
        domainFamiliarity: normalizeStringArray(
            portrait.domainFamiliarity ?? store.portraits[userId]?.domainFamiliarity,
        ),
        answerStylePreferences: normalizeStringArray(
            portrait.answerStylePreferences ?? store.portraits[userId]?.answerStylePreferences,
        ),
        longLivedConstraints: normalizeStringArray(
            portrait.longLivedConstraints ?? store.portraits[userId]?.longLivedConstraints,
        ),
        summary: portrait.summary ?? store.portraits[userId]?.summary ?? "",
        updatedAt: toIsoDate(),
    };

    store.portraits[userId] = nextPortrait;
    await writeJsonFile(paths.portraitFile, store);
    return nextPortrait;
}

export async function loadTaskState(
    threadId: string = DEFAULT_THREAD_ID,
    kbDir?: string,
): Promise<TaskState> {
    const paths = buildKbPaths(kbDir);
    const filePath = path.join(paths.threadsDir, `${encodeIdForFile(threadId)}.json`);
    return readJsonFile(filePath, createDefaultTaskState(threadId));
}

export async function saveTaskState(
    threadId: string,
    state: Partial<TaskState>,
    kbDir?: string,
): Promise<TaskState> {
    const paths = buildKbPaths(kbDir);
    const filePath = path.join(paths.threadsDir, `${encodeIdForFile(threadId)}.json`);
    const currentState = await readJsonFile<TaskState>(filePath, createDefaultTaskState(threadId));
    const nextState: TaskState = {
        ...currentState,
        ...state,
        threadId,
        unresolvedItems: normalizeStringArray(
            state.unresolvedItems ?? currentState.unresolvedItems,
        ),
        sessionOverrides: normalizeStringArray(
            state.sessionOverrides ?? currentState.sessionOverrides,
        ),
        lastActiveCategoryHints: normalizeStringArray(
            state.lastActiveCategoryHints ?? currentState.lastActiveCategoryHints,
        ),
        lastActiveDocumentHints: normalizeStringArray(
            state.lastActiveDocumentHints ?? currentState.lastActiveDocumentHints,
        ),
        updatedAt: toIsoDate(),
    };

    await writeJsonFile(filePath, nextState);
    return nextState;
}

export async function appendMemoryRecords(
    records: MemoryCandidateInput[],
    kbDir?: string,
): Promise<MemoryRecord[]> {
    const paths = buildKbPaths(kbDir);
    const normalized = records.map((record) =>
        normalizeMemoryRecord(record, record.userId ?? DEFAULT_USER_ID),
    );
    await appendJsonl(paths.memoryRecordsFile, normalized);
    return normalized;
}

export async function searchMemoryByPlan({
    userId = DEFAULT_USER_ID,
    threadId = DEFAULT_THREAD_ID,
    plan,
    kbDir,
}: {
    userId?: string;
    threadId?: string;
    plan?: RetrievalPlan;
    kbDir?: string;
}): Promise<MemorySearchResult> {
    const [portrait, taskState, allRecords] = await Promise.all([
        loadPortrait(userId, kbDir),
        loadTaskState(threadId, kbDir),
        readJsonlRecords(buildKbPaths(kbDir).memoryRecordsFile),
    ]);

    const documentIds = collectDocumentIds(plan, [], taskState);
    const categoryIds = collectCategoryIds(documentIds, [], taskState);
    const queryTokens = tokenize(
        `${plan?.intent?.user_goal ?? ""} ${plan?.intent?.answer_scope ?? ""} ${plan?.strategy?.notes ?? ""}`,
    );

    const categoryMemories = (
        await Promise.all(
            categoryIds.map((categoryId) => loadCategoryView(userId, categoryId, kbDir)),
        )
    ).filter((view): view is CategoryMemoryView => view != null);

    const documentMemories = (
        await Promise.all(documentIds.map((docId) => loadDocumentView(userId, docId, kbDir)))
    ).filter((view): view is DocumentMemoryView => view != null);

    const episodicNotes = allRecords
        .filter((record) => {
            const isThreadRecord = record.scope === "thread" && record.scopeId === threadId;
            const isDocumentRecord =
                record.scope === "document" && documentIds.includes(record.scopeId);
            const isCategoryRecord =
                record.scope === "category" && categoryIds.includes(record.scopeId);
            return (
                (isThreadRecord || isDocumentRecord || isCategoryRecord) &&
                record.kind === "episodic"
            );
        })
        .map((record) => ({
            record,
            score: scoreMemoryRecord(record, scoreRelevance(queryTokens, record)),
        }))
        .sort(
            (left, right) =>
                right.score - left.score ||
                right.record.updatedAt.localeCompare(left.record.updatedAt),
        )
        .slice(0, CONTINUATION_EPISODE_LIMIT)
        .map(({ record }) => record);

    return {
        portrait,
        taskState,
        categoryIds,
        documentIds,
        categoryMemories,
        documentMemories,
        episodicNotes,
    };
}

export async function buildContextPack({
    userId = DEFAULT_USER_ID,
    threadId = DEFAULT_THREAD_ID,
    query,
    plan,
    evidence,
    kbDir,
}: {
    userId?: string;
    threadId?: string;
    query: string;
    plan?: RetrievalPlan;
    evidence: RetrievedEvidence[];
    kbDir?: string;
}): Promise<ContextPack> {
    const memorySearch = await searchMemoryByPlan({
        userId,
        threadId,
        plan: {
            ...plan,
            document_plan: [
                ...(plan?.document_plan ?? []),
                ...evidence
                    .filter(
                        (entry) =>
                            !(plan?.document_plan ?? []).some(
                                (document) => document.doc_id === entry.docId,
                            ),
                    )
                    .map((entry, index) => ({
                        doc_id: entry.docId,
                        priority: (plan?.document_plan?.length ?? 0) + index + 1,
                        reason: "Retrieved from current evidence",
                        read_steps: [],
                    })),
            ],
        },
        kbDir,
    });

    const categoryIds = collectCategoryIds(
        memorySearch.documentIds,
        evidence,
        memorySearch.taskState,
    );
    const categoryMemories = (
        await Promise.all(
            categoryIds.map((categoryId) => loadCategoryView(userId, categoryId, kbDir)),
        )
    ).filter((view): view is CategoryMemoryView => view != null);

    const documentIds = collectDocumentIds(plan, evidence, memorySearch.taskState);
    const documentMemories = (
        await Promise.all(documentIds.map((docId) => loadDocumentView(userId, docId, kbDir)))
    ).filter((view): view is DocumentMemoryView => view != null);

    const episodicNotes =
        isContinuationQuery(query) || memorySearch.taskState.sessionOverrides.length > 0
            ? memorySearch.episodicNotes
            : [];

    const portraitSummary = buildPortraitSummary(memorySearch.portrait);
    const taskSummary = buildTaskSummary(memorySearch.taskState);
    const citationInstructions = buildCitationInstructions();

    const assembledContext = [
        `Latest user input:\n${query}`,
        taskSummary != null ? `Task/session overrides:\n${taskSummary}` : "",
        documentMemories.length > 0
            ? `Document memory:\n${documentMemories
                  .map((memory) => `${memory.docId}: ${memory.docSummary}`)
                  .join("\n")}`
            : "",
        categoryMemories.length > 0
            ? `Category memory:\n${categoryMemories
                  .map((memory) => `${memory.categoryId}: ${memory.semanticSummary}`)
                  .join("\n")}`
            : "",
        portraitSummary != null ? `Portrait defaults:\n${portraitSummary}` : "",
        episodicNotes.length > 0
            ? `Recent episodic notes:\n${episodicNotes.map((record) => `- ${record.text}`).join("\n")}`
            : "",
        evidence.length > 0
            ? `Evidence:\n${evidence
                  .flatMap((entry) =>
                      entry.blocks.map(
                          (block) => `- ${block.citation}: ${summarizeText(block.text, 220)}`,
                      ),
                  )
                  .join("\n")}`
            : "",
        `Citation instructions:\n${citationInstructions.map((line) => `- ${line}`).join("\n")}`,
    ]
        .filter((section) => section.length > 0)
        .join("\n\n");

    const contextPack: ContextPack = {
        userId,
        threadId,
        query,
        portraitSummary,
        taskSummary,
        categoryMemories,
        documentMemories,
        episodicNotes,
        evidence,
        citationInstructions,
        assembledContext,
        loadedAt: toIsoDate(),
    };

    const paths = buildKbPaths(kbDir);
    await writeCacheEntry(
        paths.contextPacksCacheFile,
        buildContextCacheKey(userId, threadId, query, documentIds),
        contextPack,
    );

    return contextPack;
}

async function appendRunArchive(entry: RunArchiveEntry, kbDir?: string): Promise<void> {
    const paths = buildKbPaths(kbDir);
    const createdAt = new Date(entry.createdAt);
    const year = String(createdAt.getUTCFullYear());
    const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
    const day = String(createdAt.getUTCDate()).padStart(2, "0");
    const targetDirectory = createDirectory(path.join(paths.archiveRoot, year, month, day));
    const filePath = path.join(
        targetDirectory,
        `run-${entry.createdAt.replace(/[:.]/gu, "-")}-${entry.id}.json`,
    );
    await writeJsonFile(filePath, entry);
}

function extractCitations(evidence: RetrievedEvidence[]): string[] {
    return evidence.flatMap((entry) => entry.blocks.map((block) => block.citation));
}

export async function rebuildCategoryMemory({
    userId = DEFAULT_USER_ID,
    categoryId,
    kbDir,
}: {
    userId?: string;
    categoryId: string;
    kbDir?: string;
}): Promise<CategoryMemoryView> {
    const paths = buildKbPaths(kbDir);
    const [records, archives] = await Promise.all([
        readJsonlRecords(paths.memoryRecordsFile),
        loadRunArchives(kbDir),
    ]);

    const categoryRecords = records.filter((record) => {
        if (record.userId !== userId) {
            return false;
        }

        if (record.scope === "category" && record.scopeId === categoryId) {
            return true;
        }

        return (
            record.scope === "document" && inferCategoryIdFromDocId(record.scopeId) === categoryId
        );
    });

    const recentArchives = archives
        .filter(
            (entry) =>
                entry.userId === userId &&
                (entry.categoryIds.includes(categoryId) ||
                    entry.documentIds.some(
                        (docId) => inferCategoryIdFromDocId(docId) === categoryId,
                    )),
        )
        .slice(0, CATEGORY_RECENT_EPISODE_SCAN_LIMIT);

    const archiveRecords = recentArchives.map((entry) =>
        buildArchivePseudoRecord(entry, "category", categoryId),
    );
    const allCandidates = [...categoryRecords, ...archiveRecords];
    const stableZone = categoryRecords
        .filter((record) => record.kind === "semantic" || record.kind === "procedural")
        .sort(
            (left, right) =>
                right.confidence - left.confidence ||
                right.salience - left.salience ||
                right.updatedAt.localeCompare(left.updatedAt),
        )
        .slice(0, 8);
    const hotZone = allCandidates
        .map((record) => ({
            record,
            score: scoreMemoryRecord(record, record.scope === "category" ? 1 : 0.7),
        }))
        .sort(
            (left, right) =>
                right.score - left.score ||
                right.record.updatedAt.localeCompare(left.record.updatedAt),
        )
        .slice(0, CATEGORY_HOT_ZONE_LIMIT)
        .map(({ record }) => record);
    const recentEpisodes = allCandidates
        .filter((record) => record.kind === "episodic" || record.kind === "task")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, CATEGORY_RECENT_EPISODE_LIMIT);

    const semanticSummary = combineSummaryTexts([
        ...stableZone.map((record) => record.text),
        ...hotZone.map((record) => record.text),
        ...recentArchives.map((entry) => summarizeText(entry.answer, 180)),
    ]);

    const recurringQuestions = [
        ...new Set(
            [
                ...recentArchives.map((entry) => summarizeText(entry.query, 160)),
                ...recentEpisodes.map((record) => summarizeText(record.text, 160)),
            ].filter((text) => text.length > 0),
        ),
    ].slice(0, 6);

    const recentDecisions = [
        ...new Set(
            stableZone
                .filter((record) => record.kind === "procedural" || record.kind === "task")
                .map((record) => summarizeText(record.text, 180)),
        ),
    ].slice(0, 4);

    const hotDocuments = [
        ...new Set(
            categoryRecords
                .filter((record) => record.scope === "document")
                .map((record) => record.scopeId)
                .concat(recentArchives.flatMap((entry) => entry.documentIds)),
        ),
    ].slice(0, 6);

    const newestSourceUpdatedAt = categoryRecords.reduce<string | null>((latest, record) => {
        if (latest == null || record.updatedAt > latest) {
            return record.updatedAt;
        }

        return latest;
    }, null);

    const view: CategoryMemoryView = {
        userId,
        categoryId,
        semanticSummary,
        recurringEntities: topKeywords([...stableZone, ...hotZone]),
        recurringQuestions,
        recentDecisions,
        hotDocuments,
        recentEpisodes,
        stable_zone: stableZone,
        hot_zone: hotZone,
        rebuildMeta: {
            lastRebuiltAt: toIsoDate(),
            sourceRecordCount: categoryRecords.length,
            newestSourceUpdatedAt,
            recentArchiveCount: recentArchives.length,
        },
        updatedAt: toIsoDate(),
    };

    const filePath = path.join(paths.categoriesDir, `${encodeIdForFile(categoryId)}.json`);
    await writeJsonFile(filePath, view);
    return view;
}

export async function rebuildDocumentMemory({
    userId = DEFAULT_USER_ID,
    docId,
    kbDir,
}: {
    userId?: string;
    docId: string;
    kbDir?: string;
}): Promise<DocumentMemoryView> {
    const paths = buildKbPaths(kbDir);
    const [records, archives, document] = await Promise.all([
        readJsonlRecords(paths.memoryRecordsFile),
        loadRunArchives(kbDir),
        loadWorkspaceDocument(paths.workspaceRoot, docId),
    ]);

    const documentRecords = records.filter(
        (record) =>
            record.userId === userId && record.scope === "document" && record.scopeId === docId,
    );
    const recentArchives = archives
        .filter(
            (entry) =>
                entry.userId === userId &&
                (entry.documentIds.includes(docId) ||
                    entry.evidence.some((evidenceEntry) => evidenceEntry.docId === docId)),
        )
        .slice(0, CATEGORY_RECENT_EPISODE_SCAN_LIMIT);

    const activeBlockIds = [
        ...new Set(
            recentArchives.flatMap((entry) =>
                entry.evidence
                    .filter((evidenceEntry) => evidenceEntry.docId === docId)
                    .flatMap((evidenceEntry) => evidenceEntry.blocks.map((block) => block.blockId)),
            ),
        ),
    ].slice(0, DOCUMENT_ACTIVE_BLOCK_LIMIT);

    const activeChapterIds = [
        ...new Set(
            recentArchives.flatMap((entry) =>
                entry.evidence
                    .filter((evidenceEntry) => evidenceEntry.docId === docId)
                    .flatMap((evidenceEntry) =>
                        evidenceEntry.blocks.map((block) => block.chapterId),
                    ),
            ),
        ),
    ].slice(0, 10);

    const relatedEdgeMap = new Map<string, { targetDocId: string; relation: string }>();
    for (const entry of recentArchives) {
        for (const candidateDocId of entry.documentIds.filter((candidate) => candidate !== docId)) {
            relatedEdgeMap.set(candidateDocId, {
                targetDocId: candidateDocId,
                relation: "co_mentioned_in_recent_run",
            });
        }
    }

    for (const record of documentRecords) {
        for (const sourceRef of record.sourceRefs.filter((candidate) =>
            candidate.startsWith("related:"),
        )) {
            const targetDocId = sourceRef.slice("related:".length);
            relatedEdgeMap.set(targetDocId, {
                targetDocId,
                relation: "memory_related_reference",
            });
        }
    }

    const relatedEdges = [...relatedEdgeMap.values()].slice(0, 8);

    const docSummary = combineSummaryTexts([
        document?.summary ?? "",
        ...documentRecords.map((record) => record.text),
        ...recentArchives.map((entry) => summarizeText(entry.answer, 180)),
    ]);

    const chapterSummaries =
        document?.chapters.map((chapter) => ({
            chapterId: chapter.chapterId,
            summary: chapter.summary,
        })) ?? [];

    let sourceDocumentUpdatedAt: string | null = null;
    if (document != null) {
        const stat = await fs.stat(document.sourcePath);
        sourceDocumentUpdatedAt = stat.mtime.toISOString();
    }

    const newestSourceUpdatedAt = documentRecords.reduce<string | null>((latest, record) => {
        if (latest == null || record.updatedAt > latest) {
            return record.updatedAt;
        }

        return latest;
    }, null);

    const view: DocumentMemoryView = {
        userId,
        docId,
        docSummary,
        chapterSummaries,
        activeChapterIds,
        activeBlockIds,
        relatedEdges,
        lastFrontier: activeBlockIds.slice(0, 8),
        rebuildMeta: {
            lastRebuiltAt: toIsoDate(),
            sourceRecordCount: documentRecords.length,
            newestSourceUpdatedAt,
            sourceDocumentUpdatedAt,
        },
        updatedAt: toIsoDate(),
    };

    const filePath = path.join(paths.documentsDir, `${encodeIdForFile(docId)}.json`);
    await writeJsonFile(filePath, view);
    return view;
}

export async function rememberTurn({
    userId = DEFAULT_USER_ID,
    threadId = DEFAULT_THREAD_ID,
    query,
    answer,
    citations,
    plan,
    evidence,
    memoryCandidates,
    kbDir,
}: {
    userId?: string;
    threadId?: string;
    query: string;
    answer: string;
    citations?: string[];
    plan?: RetrievalPlan;
    evidence: RetrievedEvidence[];
    memoryCandidates?: MemoryCandidateInput[];
    kbDir?: string;
}): Promise<{
    archiveEntry: RunArchiveEntry;
    storedRecords: MemoryRecord[];
    taskState: TaskState;
}> {
    const categoryIds = collectCategoryIds(
        plan?.document_plan?.map((document) => document.doc_id) ?? [],
        evidence,
        createDefaultTaskState(threadId),
    );
    const documentIds = [
        ...new Set(
            evidence
                .map((entry) => entry.docId)
                .concat(plan?.document_plan?.map((document) => document.doc_id) ?? []),
        ),
    ];
    const sourceRefs = citations ?? extractCitations(evidence);

    const normalizedCandidates =
        memoryCandidates != null && memoryCandidates.length > 0
            ? memoryCandidates.map((candidate) => ({
                  ...candidate,
                  userId,
                  sourceRefs: normalizeStringArray(candidate.sourceRefs ?? sourceRefs),
              }))
            : [
                  {
                      ...createFallbackRecord(userId, threadId, query, answer, sourceRefs),
                  },
              ];

    const storedRecords = await appendMemoryRecords(normalizedCandidates, kbDir);

    const archiveEntry: RunArchiveEntry = {
        id: generateUUID(),
        userId,
        threadId,
        query,
        answer,
        citations: sourceRefs,
        plan: plan ?? null,
        evidence,
        categoryIds,
        documentIds,
        memoryRecordIds: storedRecords.map((record) => record.id),
        createdAt: toIsoDate(),
    };
    await appendRunArchive(archiveEntry, kbDir);

    const currentTaskState = await loadTaskState(threadId, kbDir);
    const taskState = await saveTaskState(
        threadId,
        {
            goal: plan?.intent?.user_goal ?? currentTaskState.goal,
            lastSummary: summarizeText(answer, 260),
            lastActiveCategoryHints: categoryIds,
            lastActiveDocumentHints: documentIds,
        },
        kbDir,
    );

    const paths = buildKbPaths(kbDir);
    for (const categoryId of categoryIds) {
        const currentView = await loadCategoryView(userId, categoryId, kbDir);
        const records = (await readJsonlRecords(paths.memoryRecordsFile)).filter(
            (record) =>
                record.userId === userId &&
                ((record.scope === "category" && record.scopeId === categoryId) ||
                    (record.scope === "document" &&
                        inferCategoryIdFromDocId(record.scopeId) === categoryId)),
        );
        const recentArchiveCount = (await loadRunArchives(kbDir)).filter(
            (entry) =>
                entry.userId === userId &&
                (entry.categoryIds.includes(categoryId) ||
                    entry.documentIds.some(
                        (docId) => inferCategoryIdFromDocId(docId) === categoryId,
                    )),
        ).length;

        if (needsCategoryRebuild(currentView, records, recentArchiveCount)) {
            await rebuildCategoryMemory({ userId, categoryId, kbDir });
        }
    }

    for (const docId of documentIds) {
        const currentView = await loadDocumentView(userId, docId, kbDir);
        if (await needsDocumentRebuild(currentView, docId, evidence, kbDir)) {
            await rebuildDocumentMemory({ userId, docId, kbDir });
        }
    }

    await writeCacheEntry(paths.frontiersCacheFile, stableHash(`${threadId}:${query}`), {
        threadId,
        query,
        documentIds,
        blockIds: evidence.flatMap((entry) => entry.blocks.map((block) => block.blockId)),
        updatedAt: toIsoDate(),
    });

    return {
        archiveEntry,
        storedRecords,
        taskState,
    };
}
