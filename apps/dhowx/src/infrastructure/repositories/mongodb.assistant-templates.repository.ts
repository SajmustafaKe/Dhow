import { z } from "zod";
import { Filter, ObjectId } from "mongodb";
import { db } from "@/app/lib/mongodb";
import { AssistantTemplate, AssistantTemplateLike } from "@/src/entities/models/assistant-template";
import { PaginatedList } from "@/src/entities/common/paginated-list";

type Doc = Omit<z.infer<typeof AssistantTemplate>, "id">;
type LikeDoc = Omit<z.infer<typeof AssistantTemplateLike>, "id">;

export class MongoDBAssistantTemplatesRepository {
    private readonly collection = db.collection<Doc>("assistant_templates");
    private readonly likesCollection = db.collection<LikeDoc>("assistant_template_likes");

    async create(data: Omit<z.infer<typeof AssistantTemplate>, 'id' | 'publishedAt' | 'lastUpdatedAt'>): Promise<z.infer<typeof AssistantTemplate>> {
        const now = new Date().toISOString();
        const _id = new ObjectId();
        const doc: Doc = { ...data, publishedAt: now, lastUpdatedAt: now };
        await this.collection.insertOne({ ...doc, _id });
        return { ...doc, id: _id.toString() };
    }

    async fetch(id: string): Promise<z.infer<typeof AssistantTemplate> | null> {
        const result = await this.collection.findOne({ _id: new ObjectId(id) });
        if (!result) return null;
        return { ...result, id: result._id.toString() };
    }

    async list(filters: {
        category?: string;
        search?: string;
        featured?: boolean;
        isPublic?: boolean;
        authorId?: string;
        source?: 'library' | 'community';
    } = {}, cursor?: string, limit: number = 20): Promise<z.infer<ReturnType<typeof PaginatedList<typeof AssistantTemplate>>>> {
        const query: Filter<Doc> = {};
        if (filters.category) query.category = filters.category;
        if (filters.featured !== undefined) query.featured = filters.featured;
        if (filters.isPublic !== undefined) query.isPublic = filters.isPublic;
        if (filters.authorId) query.authorId = filters.authorId;
        if (filters.source) query.source = filters.source;
        if (filters.search) {
            // Escaped before it reaches $regex. Raw user input compiled as a
            // pattern let an unbalanced parenthesis throw SyntaxError straight
            // out of list() (an uncaught-crash DoS from ordinary search text),
            // and let a crafted pattern drive catastrophic backtracking.
            // Search here is a substring match, so regex metacharacters have no
            // meaning to the caller and losing them costs nothing.
            const search = escapeRegExp(filters.search);
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
                { tags: { $in: [new RegExp(search, 'i')] } },
            ];
        }

        const skip = cursor ? parseInt(cursor) : 0;
        // Stable sort: newest first, with _id as tiebreaker to ensure deterministic pages
        const results = await this.collection
            .find(query)
            .sort({ publishedAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
        const items = results.map(r => ({ ...r, id: r._id.toString() }));
        const nextCursor = results.length === limit ? (skip + limit).toString() : null;
        return { items, nextCursor };
    }

    async toggleLike(assistantId: string, userId: string, userEmail?: string): Promise<{ liked: boolean; likeCount: number }> {
        const existingLike = await this.likesCollection.findOne({ assistantId, userId });
        if (existingLike) {
            await this.likesCollection.deleteOne({ _id: existingLike._id });
            await this.collection.updateOne({ _id: new ObjectId(assistantId) }, { $inc: { likeCount: -1 }, $pull: { likes: userId } });
            return { liked: false, likeCount: await this.getLikeCount(assistantId) };
        } else {
            const now = new Date().toISOString();
            await this.likesCollection.insertOne({ assistantId, userId, userEmail, createdAt: now });
            await this.collection.updateOne({ _id: new ObjectId(assistantId) }, { $inc: { likeCount: 1 }, $addToSet: { likes: userId } });
            return { liked: true, likeCount: await this.getLikeCount(assistantId) };
        }
    }

    async getLikeCount(assistantId: string): Promise<number> {
        const result = await this.collection.findOne({ _id: new ObjectId(assistantId) }, { projection: { likeCount: 1 } });
        return result?.likeCount || 0;
    }

    async getLikedTemplates(templateIds: string[], userId: string): Promise<string[]> {
        const likes = await this.likesCollection.find({ 
            assistantId: { $in: templateIds }, 
            userId 
        }).toArray();
        return likes.map(like => like.assistantId);
    }

    async getCategories(): Promise<string[]> {
        const categories = await this.collection.distinct('category', { isPublic: true });
        return categories.filter(Boolean);
    }

    async deleteByIdAndAuthor(id: string, authorId: string): Promise<boolean> {
        const result = await this.collection.deleteOne({ _id: new ObjectId(id), authorId });
        if (result.deletedCount && result.deletedCount > 0) {
            // Clean up likes associated with this assistant template
            await this.likesCollection.deleteMany({ assistantId: id });
            return true;
        }
        return false;
    }
}

/**
 * Neutralise regex metacharacters in caller-supplied search text.
 *
 * `list()` treats `search` as a substring match, but passed it to `$regex`
 * verbatim. Any string is a valid substring; not every string is a valid
 * pattern. `foo(` threw a SyntaxError out of the repository, and a pattern like
 * `(a+)+$` invites catastrophic backtracking against Mongo.
 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


