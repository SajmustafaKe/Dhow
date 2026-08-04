import { ObjectId } from "mongodb";
import { db } from "@/app/lib/mongodb";
import { prebuiltTemplates } from "@/app/lib/prebuilt-cards";

// Cache to track which templates have been seeded
const seededTemplates = new Set<string>();

// idempotent seed: creates library (prebuilt) templates in DB if missing
// Uses name+authorName match to avoid duplicates; tags include a stable prebuilt key
export async function ensureLibraryTemplatesSeeded(): Promise<void> {
    try {
        const collection = db.collection("assistant_templates");
        const now = new Date().toISOString();
        
        console.log('[PrebuiltTemplates] Starting template seeding...');

        const entries = Object.entries(prebuiltTemplates);
        const currentPrebuiltKeys = new Set<string>(entries.map(([key]) => key));
        for (const [prebuiltKey, tpl] of entries) {
            // minimal guard; only ingest valid workflow-like objects
            if (!tpl?.agents || !Array.isArray(tpl.agents)) continue;

            const name = tpl.name || prebuiltKey;

            // Upsert to avoid race-condition duplicates
            const filter = {
                authorName: "Dhow",
                source: 'library',
                tags: { $all: ["__library__", `prebuilt:${prebuiltKey}`] },
            } as const;
            const doc = {
                name,
                description: tpl.description || "",
                category: tpl.category || "Other",
                authorId: "dhow-system",
                authorName: "Dhow",
                authorEmail: undefined,
                isAnonymous: false,
                workflow: tpl,
                tags: ["__library__", `prebuilt:${prebuiltKey}`].filter(Boolean),
                publishedAt: now,
                lastUpdatedAt: now,
                downloadCount: 0,
                likeCount: 0,
                featured: false,
                isPublic: true,
                likes: [] as string[],
                copilotPrompt: tpl.copilotPrompt || undefined,
                thumbnailUrl: undefined,
                source: 'library' as const,
            } as const;
            await collection.updateOne(
                filter,
                { $setOnInsert: doc },
                { upsert: true }
            );
        }

        // Strong reconcile: ensure DB exactly matches code exports
        try {
            const libCursor = collection.find({
                source: 'library',
                authorName: 'Dhow',
                tags: { $in: ["__library__"] },
            }, { projection: { _id: 1, tags: 1, name: 1, publishedAt: 1 } });

            type DocLite = { _id: ObjectId; tags?: string[]; name?: string; publishedAt?: string };
            const keyToDocs = new Map<string, DocLite[]>();
            const orphans: ObjectId[] = [];
            const orphanNames: string[] = [];

            for await (const doc of libCursor) {
                const prebuiltTag = (doc.tags || []).find((t: string) => typeof t === 'string' && t.startsWith('prebuilt:'));
                if (!prebuiltTag) {
                    orphans.push(doc._id);
                    if (doc.name) orphanNames.push(doc.name);
                    continue;
                }
                const key = prebuiltTag.replace('prebuilt:', '');
                if (!currentPrebuiltKeys.has(key)) {
                    orphans.push(doc._id);
                    if (doc.name) orphanNames.push(doc.name);
                    continue;
                }
                const arr = keyToDocs.get(key) || [];
                arr.push(doc);
                keyToDocs.set(key, arr);
            }

            // Delete orphans (no key or key not in code)
            if (orphans.length > 0) {
                await collection.deleteMany({ _id: { $in: orphans } });
                console.log(`[PrebuiltTemplates] Reconciled by deleting ${orphans.length} orphans/removed templates:`, orphanNames);
            }

            // For each key, keep newest by publishedAt; delete others
            const dupRemovals: ObjectId[] = [];
            for (const [, docs] of keyToDocs.entries()) {
                if (docs.length <= 1) continue;
                const sorted = [...docs].sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
                const extras = sorted.slice(1).map(d => d._id);
                dupRemovals.push(...extras);
            }
            if (dupRemovals.length > 0) {
                await collection.deleteMany({ _id: { $in: dupRemovals } });
                console.log(`[PrebuiltTemplates] De-duplicated ${dupRemovals.length} duplicate templates`);
            }
        } catch (reconcileErr) {
            console.error('[PrebuiltTemplates] Reconcile (strict sync) failed:', reconcileErr);
        }
    } catch (err) {
        // best-effort seed; do not throw to avoid breaking requests
        console.error("ensureLibraryTemplatesSeeded error:", err);
    }
}

// Lazy seed: only seed a specific template when it's requested
export async function ensureTemplateSeeded(prebuiltKey: string): Promise<void> {
    if (seededTemplates.has(prebuiltKey)) {
        return; // Already seeded
    }

    const tpl = prebuiltTemplates[prebuiltKey as keyof typeof prebuiltTemplates];
    if (!tpl) {
        console.warn(`[PrebuiltTemplates] Template not found: ${prebuiltKey}`);
        return;
    }

    try {
        const collection = db.collection("assistant_templates");
        const now = new Date().toISOString();
        const name = tpl.name || prebuiltKey;

        // Check if already exists
        const existing = await collection.findOne({ 
            name, 
            authorName: "Dhow", 
            tags: { $in: [ `prebuilt:${prebuiltKey}`, "__library__" ] } 
        });

        if (existing) {
            // Update existing template with current model configuration
            const defaultModel = process.env.PROVIDER_DEFAULT_MODEL || 'gpt-4.1';
            const updatedWorkflow = JSON.parse(JSON.stringify(tpl)) as typeof tpl;
            
            // Apply model transformation
            if (updatedWorkflow.agents && Array.isArray(updatedWorkflow.agents)) {
                updatedWorkflow.agents.forEach((agent) => {
                    if (agent.model === '') {
                        agent.model = defaultModel;
                    }
                });
            }

            await collection.updateOne(
                { _id: existing._id },
                { 
                    $set: {
                        workflow: updatedWorkflow,
                        lastUpdatedAt: now,
                    }
                }
            );
            console.log(`[PrebuiltTemplates] Updated template: ${name}`);
        } else {
            // Create new template with model transformation
            const defaultModel = process.env.PROVIDER_DEFAULT_MODEL || 'gpt-4.1';
            const transformedWorkflow = JSON.parse(JSON.stringify(tpl)) as typeof tpl;
            
            // Apply model transformation
            if (transformedWorkflow.agents && Array.isArray(transformedWorkflow.agents)) {
                transformedWorkflow.agents.forEach((agent) => {
                    if (agent.model === '') {
                        agent.model = defaultModel;
                    }
                });
            }

            const doc = {
                name,
                description: tpl.description || "",
                category: tpl.category || "Other",
                authorId: "dhow-system",
                authorName: "Dhow",
                authorEmail: undefined,
                isAnonymous: false,
                workflow: transformedWorkflow,
                tags: ["__library__", `prebuilt:${prebuiltKey}`].filter(Boolean),
                publishedAt: now,
                lastUpdatedAt: now,
                downloadCount: 0,
                likeCount: 0,
                featured: false,
                isPublic: true,
                likes: [] as string[],
                copilotPrompt: tpl.copilotPrompt || undefined,
                thumbnailUrl: undefined,
                source: 'library' as const,
            } as const;

            await collection.insertOne(doc);
            console.log(`[PrebuiltTemplates] Created template: ${name}`);
        }

        seededTemplates.add(prebuiltKey);
    } catch (err) {
        console.error(`[PrebuiltTemplates] Error seeding template ${prebuiltKey}:`, err);
    }
}


