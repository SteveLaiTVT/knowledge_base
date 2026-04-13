import fs from "node:fs/promises";
import path from "node:path";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { CodexBuilder, type AgentPermission } from "../CodexBuilder.js";
import { assertWorkspaceAccess } from "../../tools/FileUtility.js";
import {
    buildContextPack,
    type ContextPack,
    type EvidenceBlock,
    type MemoryCandidateInput,
    type RetrievalPlan,
    type RetrievalPlanDocument,
    type RetrievedEvidence,
    rememberTurn,
} from "../../tools/memory/index.js";
import {
    listWorkspaceDocuments,
    loadWorkspaceDocument,
    type DocumentBlock,
    type WorkspaceDocument,
} from "../../tools/docs/markdownDocument.js";

const DEFAULT_THREAD_ID = "default";
const QUERY_PLAN_CACHE_FILE = path.join(".codex-kb", "cache", "query-plans.json");
const RUNTIME_CONSTRAINTS = ["summary", "structure", "page_range", "full_text_short"];

export interface PlanExecutionInput {
    query: string;
    conversationContext: string;
    documentCatalog: WorkspaceDocument[];
    runtimeConstraints: string[];
}

export interface AnswerExecutionInput {
    query: string;
    plan: RetrievalPlan;
    contextPack: ContextPack;
    evidence: RetrievedEvidence[];
}

export interface PlanOptions {
    threadId?: string;
    conversationContext?: string;
    planner?: (input: PlanExecutionInput) => Promise<RetrievalPlan>;
}

export interface SearchOptions extends PlanOptions {
    plan?: RetrievalPlan;
}

export interface AskOptions extends SearchOptions {
    userId?: string;
    responder?: (input: AnswerExecutionInput) => Promise<string>;
    memoryCandidates?: MemoryCandidateInput[];
}

export interface PlanResult {
    threadId: string;
    documentCatalog: WorkspaceDocument[];
    plan: RetrievalPlan;
}

export interface SearchResult extends PlanResult {
    evidence: RetrievedEvidence[];
}

export interface AskResult extends SearchResult {
    contextPack: ContextPack;
    answer: string;
    citations: string[];
}

export interface OrchestratorAgentOptions {
    workspace?: string;
    model?: string;
    reasoningEffort?: ModelReasoningEffort;
    permission?: AgentPermission;
}

function tokenize(text: string): string[] {
    return [
        ...new Set(
            text
                .toLowerCase()
                .split(/[^a-z0-9]+/u)
                .filter((token) => token.length > 2),
        ),
    ];
}

function summarizeText(text: string, maxLength: number = 240): string {
    const normalized = text.replace(/\s+/gu, " ").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function renderTemplate(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/gu, (_match, key: string) => values[key] ?? "");
}

function parseJsonResponse<TValue>(response: string): TValue {
    try {
        return JSON.parse(response) as TValue;
    } catch {
        const start = response.indexOf("{");
        const end = response.lastIndexOf("}");
        if (start >= 0 && end > start) {
            return JSON.parse(response.slice(start, end + 1)) as TValue;
        }

        throw new Error("Codex did not return valid JSON.");
    }
}

function scoreOverlap(tokens: string[], haystack: string): number {
    if (tokens.length === 0) {
        return 0;
    }

    const haystackTokens = new Set(tokenize(haystack));
    const matches = tokens.filter((token) => haystackTokens.has(token)).length;
    return matches / tokens.length;
}

function buildConversationContext(explicitContext: string | undefined, threadId: string): string {
    const parts = [
        explicitContext?.trim() ?? "",
        threadId !== DEFAULT_THREAD_ID ? `Thread memory id: ${threadId}` : "",
    ].filter((value) => value.length > 0);

    return parts.join("\n");
}

async function writeQueryPlanCache(
    workspace: string,
    query: string,
    threadId: string,
    plan: RetrievalPlan,
): Promise<void> {
    const filePath = path.join(workspace, QUERY_PLAN_CACHE_FILE);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const cache = JSON.parse(
        await fs.readFile(filePath, "utf-8").catch(() => '{"entries":{}}'),
    ) as { entries: Record<string, unknown> };
    const key = `${threadId}:${query}`;
    cache.entries[key] = {
        query,
        threadId,
        plan,
        updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(filePath, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
}

function createBlockCitation(docId: string, block: DocumentBlock): string {
    return block.page != null
        ? `${docId}#page-${block.page}:${block.blockId}`
        : `${docId}#${block.blockId}`;
}

function scoreBlock(
    query: string,
    planDocument: RetrievalPlanDocument | undefined,
    block: DocumentBlock,
): number {
    const stepHints =
        planDocument?.read_steps
            .map((step: { goal: string; target: string }) => `${step.goal} ${step.target}`)
            .join(" ") ?? "";
    const queryTokens = tokenize(`${query} ${planDocument?.reason ?? ""} ${stepHints}`);
    const chapterBoost = scoreOverlap(queryTokens, block.chapterTitle) * 0.2;
    const textScore = scoreOverlap(queryTokens, block.text);
    return textScore + chapterBoost;
}

async function readPromptTemplate(fileName: string): Promise<string> {
    const promptUrl = new URL(`./${fileName}`, import.meta.url);
    return fs.readFile(promptUrl, "utf-8");
}

export class OrchestratorAgent {
    private readonly workspace: string;

    private readonly model?: string;

    private readonly reasoningEffort?: ModelReasoningEffort;

    private readonly permission: AgentPermission;

    public constructor(options: OrchestratorAgentOptions = {}) {
        this.workspace = assertWorkspaceAccess(options.workspace);
        this.model = options.model;
        this.reasoningEffort = options.reasoningEffort;
        this.permission = options.permission ?? "local_only";
    }

    public async plan(query: string, options: PlanOptions = {}): Promise<PlanResult> {
        const threadId = options.threadId ?? DEFAULT_THREAD_ID;
        const documentCatalog = await listWorkspaceDocuments(this.workspace);
        const plannerInput: PlanExecutionInput = {
            query,
            conversationContext: buildConversationContext(options.conversationContext, threadId),
            documentCatalog,
            runtimeConstraints: RUNTIME_CONSTRAINTS,
        };

        const plan =
            options.planner != null
                ? await options.planner(plannerInput)
                : await this.planWithCodex(plannerInput);

        await writeQueryPlanCache(this.workspace, query, threadId, plan);

        return {
            threadId,
            documentCatalog,
            plan,
        };
    }

    public async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
        const planResult =
            options.plan != null
                ? {
                      threadId: options.threadId ?? DEFAULT_THREAD_ID,
                      documentCatalog: await listWorkspaceDocuments(this.workspace),
                      plan: options.plan,
                  }
                : await this.plan(query, options);

        if (planResult.plan.need_clarification === true) {
            return {
                ...planResult,
                evidence: [],
            };
        }

        const selectedDocuments = this.selectDocuments(
            query,
            planResult.documentCatalog,
            planResult.plan,
        );
        const evidence = await Promise.all(
            selectedDocuments.map(async (document) => {
                const parsedDocument = await loadWorkspaceDocument(this.workspace, document.docId);
                if (parsedDocument == null) {
                    return null;
                }

                const planDocument = planResult.plan.document_plan?.find(
                    (candidate) => candidate.doc_id === document.docId,
                );
                const rankedBlocks = [...parsedDocument.blocks]
                    .map((block) => ({
                        block,
                        score: scoreBlock(query, planDocument, block),
                    }))
                    .sort((left, right) => right.score - left.score);
                const chosenBlocks = rankedBlocks
                    .filter((entry, index) => entry.score > 0 || index === 0)
                    .slice(0, 3)
                    .map(({ block, score }) => ({
                        docId: parsedDocument.docId,
                        blockId: block.blockId,
                        categoryId: parsedDocument.categoryId,
                        chapterId: block.chapterId,
                        page: block.page,
                        text: block.text,
                        citation: createBlockCitation(parsedDocument.docId, block),
                        score,
                    })) satisfies EvidenceBlock[];

                return {
                    docId: parsedDocument.docId,
                    categoryId: parsedDocument.categoryId,
                    title: parsedDocument.title,
                    summary: parsedDocument.summary,
                    sourcePath: parsedDocument.sourcePath,
                    blocks: chosenBlocks,
                } satisfies RetrievedEvidence;
            }),
        );

        return {
            ...planResult,
            evidence: evidence.filter((entry): entry is RetrievedEvidence => entry != null),
        };
    }

    public async ask(query: string, options: AskOptions = {}): Promise<AskResult> {
        const threadId = options.threadId ?? DEFAULT_THREAD_ID;
        const searchResult = await this.search(query, {
            ...options,
            threadId,
        });
        const contextPack = await buildContextPack({
            userId: options.userId ?? "local",
            threadId,
            query,
            plan: searchResult.plan,
            evidence: searchResult.evidence,
            kbDir: this.workspace,
        });

        const answer =
            searchResult.plan.need_clarification === true
                ? (searchResult.plan.clarification_question ??
                  "I need a bit more detail before I can answer accurately.")
                : options.responder != null
                  ? await options.responder({
                        query,
                        plan: searchResult.plan,
                        contextPack,
                        evidence: searchResult.evidence,
                    })
                  : await this.answerWithCodex({
                        query,
                        plan: searchResult.plan,
                        contextPack,
                        evidence: searchResult.evidence,
                    });

        const citations =
            searchResult.evidence.length > 0
                ? searchResult.evidence.flatMap((entry) =>
                      entry.blocks.map((block) => block.citation),
                  )
                : [];

        await rememberTurn({
            userId: options.userId ?? "local",
            threadId,
            query,
            answer,
            citations,
            plan: searchResult.plan,
            evidence: searchResult.evidence,
            memoryCandidates: options.memoryCandidates,
            kbDir: this.workspace,
        });

        return {
            ...searchResult,
            contextPack,
            answer,
            citations,
        };
    }

    private selectDocuments(
        query: string,
        documentCatalog: WorkspaceDocument[],
        plan: RetrievalPlan,
    ): WorkspaceDocument[] {
        if (plan.document_plan != null && plan.document_plan.length > 0) {
            return [...plan.document_plan]
                .sort((left, right) => left.priority - right.priority)
                .map((planDocument) =>
                    documentCatalog.find((document) => document.docId === planDocument.doc_id),
                )
                .filter((document): document is WorkspaceDocument => document != null);
        }

        const queryTokens = tokenize(query);
        return [...documentCatalog]
            .map((document) => ({
                document,
                score:
                    scoreOverlap(queryTokens, document.title) * 0.5 +
                    scoreOverlap(queryTokens, document.summary) * 0.5,
            }))
            .sort((left, right) => right.score - left.score)
            .slice(0, 3)
            .map(({ document }) => document);
    }

    private createBuilder(prompt: string): CodexBuilder {
        const builder = new CodexBuilder(this.workspace)
            .withPermission(this.permission)
            .withPrompt(prompt);

        if (this.model != undefined) {
            builder.withModel(this.model);
        }

        if (this.reasoningEffort != undefined) {
            builder.withReasoningEffort(this.reasoningEffort);
        }

        return builder;
    }

    private async planWithCodex(input: PlanExecutionInput): Promise<RetrievalPlan> {
        const template = await readPromptTemplate("prompt.md");
        const prompt = renderTemplate(template, {
            user_query: input.query,
            conversation_context: input.conversationContext || "No prior context available.",
            document_catalog: JSON.stringify(input.documentCatalog, null, 2),
            runtime_constraints: JSON.stringify(input.runtimeConstraints, null, 2),
        });
        const session = this.createBuilder(prompt).build();
        const result = await session.run("Return only the retrieval plan JSON.");
        return parseJsonResponse<RetrievalPlan>(result.finalResponse);
    }

    private async answerWithCodex(input: AnswerExecutionInput): Promise<string> {
        const template = await readPromptTemplate("answer-prompt.md");
        const prompt = renderTemplate(template, {
            user_query: input.query,
            context_pack: input.contextPack.assembledContext,
            retrieval_plan: JSON.stringify(input.plan, null, 2),
            retrieved_evidence: JSON.stringify(
                input.evidence.map((entry) => ({
                    docId: entry.docId,
                    title: entry.title,
                    blocks: entry.blocks.map((block) => ({
                        citation: block.citation,
                        chapterId: block.chapterId,
                        page: block.page,
                        text: summarizeText(block.text, 420),
                    })),
                })),
                null,
                2,
            ),
        });
        const session = this.createBuilder(prompt).build();
        const result = await session.run("Answer the user request.");
        return result.finalResponse.trim();
    }
}
