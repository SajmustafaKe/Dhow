import { db } from "@/app/lib/mongodb";
import { CreateSchema, IProjectsRepository, AddComposioConnectedAccountSchema, AddCustomMcpServerSchema } from "@/src/application/repositories/projects.repository.interface";
import { BadRequestError, NotFoundError } from "@/src/entities/errors/common";
import { Project } from "@/src/entities/models/project";
import { z } from "zod";
import { IProjectMembersRepository } from "@/src/application/repositories/project-members.repository.interface";
import { PaginatedList } from "@/src/entities/common/paginated-list";

type Doc = Omit<z.infer<typeof Project>, "id"> & { _id: string };

export class MongodbProjectsRepository implements IProjectsRepository {
    private readonly projectMembersRepository: IProjectMembersRepository;
    private collection = db.collection<Doc>('projects');

    constructor({
        projectMembersRepository,
    }: {
        projectMembersRepository: IProjectMembersRepository,
    }) {
        this.projectMembersRepository = projectMembersRepository;
    }

    async create(data: z.infer<typeof CreateSchema>): Promise<z.infer<typeof Project>> {
        const now = new Date();

        const wflow = {
            ...data.workflow,
            lastUpdatedAt: now.toISOString(),
        };

        const id = crypto.randomUUID();

        const doc = {
            ...data,
            liveWorkflow: wflow,
            draftWorkflow: wflow,
            createdAt: now.toISOString(),
        };
        await this.collection.insertOne({
            ...doc,
            _id: id,
        });
        return {
            ...doc,
            id,
        };
    }

    async fetch(id: string): Promise<z.infer<typeof Project> | null> {
        const doc = await this.collection.findOne({ _id: id });
        if (!doc) {
            return null;
        }
        const { _id, ...rest } = doc;
        return {
            ...rest,
            id,
        };
    }

    async countCreatedProjects(createdByUserId: string): Promise<number> {
        return await this.collection.countDocuments({ createdByUserId });
    }

    async listProjects(userId: string, cursor?: string, limit?: number): Promise<z.infer<ReturnType<typeof PaginatedList<typeof Project>>>> {
        const memberships = await this.projectMembersRepository.findByUserId(userId, cursor, limit);
        const projectIds = memberships.items.map((m) => m.projectId);
        const projects = await this.collection.find({
            _id: { $in: projectIds },
        }).toArray();
        return {
            items: projects.map((p) => ({
                ...p,
                id: p._id,
            })),
            nextCursor: memberships.nextCursor,
        };
    }

    async addComposioConnectedAccount(projectId: string, data: z.infer<typeof AddComposioConnectedAccountSchema>): Promise<z.infer<typeof Project>> {
        const key = `composioConnectedAccounts.${assertPlainKey(data.toolkitSlug, 'toolkitSlug')}`;
        const result = await this.collection.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    [key]: data.data,
                    lastUpdatedAt: new Date().toISOString(),
                }
            },
            { returnDocument: 'after' }
        );
        if (!result) {
            throw new NotFoundError('Project not found');
        }
        const { _id, ...rest } = result;
        return { ...rest, id: _id };
    }

    async deleteComposioConnectedAccount(projectId: string, toolkitSlug: string): Promise<boolean> {
        const result = await this.collection.updateOne({
            _id: projectId,
        }, {
            $unset: {
                [`composioConnectedAccounts.${assertPlainKey(toolkitSlug, 'toolkitSlug')}`]: "",
            }
        });
        return result.modifiedCount > 0;
    }

    async addCustomMcpServer(projectId: string, data: z.infer<typeof AddCustomMcpServerSchema>): Promise<z.infer<typeof Project>> {
        const key = `customMcpServers.${assertPlainKey(data.name, 'name')}`;
        const result = await this.collection.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    [key]: data.data,
                    lastUpdatedAt: new Date().toISOString(),
                }
            },
            { returnDocument: 'after' }
        );
        if (!result) {
            throw new NotFoundError('Project not found');
        }
        const { _id, ...rest } = result;
        return { ...rest, id: _id };
    }

    async deleteCustomMcpServer(projectId: string, name: string): Promise<boolean> {
        const result = await this.collection.updateOne({
            _id: projectId,
        }, {
            $unset: {
                [`customMcpServers.${assertPlainKey(name, 'name')}`]: "",
            }
        });
        return result.modifiedCount > 0;
    }

    async updateSecret(projectId: string, secret: string): Promise<z.infer<typeof Project>> {
        const result = await this.collection.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    secret,
                    lastUpdatedAt: new Date().toISOString(),
                }
            },
            { returnDocument: 'after' }
        );
        if (!result) {
            throw new NotFoundError('Project not found');
        }
        const { _id, ...rest } = result;
        return { ...rest, id: _id };
    }

    async updateWebhookUrl(projectId: string, url: string): Promise<z.infer<typeof Project>> {
        const result = await this.collection.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    webhookUrl: url,
                    lastUpdatedAt: new Date().toISOString(),
                }
            },
            { returnDocument: 'after' }
        );
        if (!result) {
            throw new NotFoundError('Project not found');
        }
        const { _id, ...rest } = result;
        return { ...rest, id: _id };
    }

    async updateName(projectId: string, name: string): Promise<z.infer<typeof Project>> {
        const result = await this.collection.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    name,
                    lastUpdatedAt: new Date().toISOString(),
                }
            },
            { returnDocument: 'after' }
        );
        if (!result) {
            throw new NotFoundError('Project not found');
        }
        const { _id, ...rest } = result;
        return { ...rest, id: _id };
    }

    async updateDraftWorkflow(projectId: string, workflow: z.infer<typeof import("@/app/lib/types/workflow_types").Workflow>): Promise<z.infer<typeof Project>> {
        const result = await this.collection.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    draftWorkflow: workflow,
                    lastUpdatedAt: new Date().toISOString(),
                }
            },
            { returnDocument: 'after' }
        );
        if (!result) {
            throw new NotFoundError('Project not found');
        }
        const { _id, ...rest } = result;
        return { ...rest, id: _id };
    }

    async updateLiveWorkflow(projectId: string, workflow: z.infer<typeof import("@/app/lib/types/workflow_types").Workflow>): Promise<z.infer<typeof Project>> {
        const result = await this.collection.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    liveWorkflow: workflow,
                    lastUpdatedAt: new Date().toISOString(),
                }
            },
            { returnDocument: 'after' }
        );
        if (!result) {
            throw new NotFoundError('Project not found');
        }
        const { _id, ...rest } = result;
        return { ...rest, id: _id };
    }

    async delete(projectId: string): Promise<boolean> {
        const result = await this.collection.deleteOne({ _id: projectId });
        return result.deletedCount > 0;
    }
}

/**
 * Guard a caller-supplied value before it becomes part of a Mongo field path.
 *
 * `composioConnectedAccounts.${toolkitSlug}` and `customMcpServers.${name}` are
 * built by interpolation, so a value containing a dot silently deepens the
 * write path — `a.b` targets `customMcpServers.a.b`, a different document
 * location than the one the caller named. A leading `$` is refused for the same
 * reason: field paths and operators share a namespace.
 *
 * Throws rather than sanitising. Rewriting the key would write to a location the
 * caller did not ask for, which is the failure being prevented.
 */
function assertPlainKey(value: string, field: string): string {
    if (!value || value.includes('.') || value.startsWith('$')) {
        throw new BadRequestError(`Invalid ${field}: must be non-empty and contain no '.' or leading '$'`);
    }
    return value;
}