import { asClass, createContainer, InjectionMode } from "awilix";

// Repositories
import { MongoDBApiKeysRepository } from "@/src/infrastructure/repositories/mongodb.api-keys.repository";
import { MongoDBAssistantTemplatesRepository } from "@/src/infrastructure/repositories/mongodb.assistant-templates.repository";
import { MongodbComposioTriggerDeploymentsRepository } from "@/src/infrastructure/repositories/mongodb.composio-trigger-deployments.repository";
import { MongoDBConversationsRepository } from "@/src/infrastructure/repositories/mongodb.conversations.repository";
import { MongoDBDataSourceDocsRepository } from "@/src/infrastructure/repositories/mongodb.data-source-docs.repository";
import { MongoDBDataSourcesRepository } from "@/src/infrastructure/repositories/mongodb.data-sources.repository";
import { MongoDBJobsRepository } from "@/src/infrastructure/repositories/mongodb.jobs.repository";
import { MongoDBProjectMembersRepository } from "@/src/infrastructure/repositories/mongodb.project-members.repository";
import { MongodbProjectsRepository } from "@/src/infrastructure/repositories/mongodb.projects.repository";
import { MongoDBRecurringJobRulesRepository } from "@/src/infrastructure/repositories/mongodb.recurring-job-rules.repository";
import { MongoDBScheduledJobRulesRepository } from "@/src/infrastructure/repositories/mongodb.scheduled-job-rules.repository";
import { MongoDBUsersRepository } from "@/src/infrastructure/repositories/mongodb.users.repository";

// Services
import { RedisCacheService } from "@/src/infrastructure/services/redis.cache.service";
import { RedisPubSubService } from "@/src/infrastructure/services/redis.pub-sub.service";
import { S3UploadsStorageService } from "@/src/infrastructure/services/s3.uploads-storage.service";
import { LocalUploadsStorageService } from "@/src/infrastructure/services/local.uploads-storage.service";

// Policies
import { RedisUsageQuotaPolicy } from "@/src/infrastructure/policies/redis.usage-quota.policy";

/**
 * Data/domain-layer DI container.
 *
 * This is a deliberately narrow slice of apps/dhow's di/container.ts: it
 * registers only the repositories, infrastructure services, and infra
 * policies owned by the data-layer port (src/entities, src/application/
 * repositories, src/infrastructure). apps/dhow's container additionally
 * wires use-cases, controllers, workers, and the application-layer
 * project-action-authorization policy — those belong to later port waves
 * and register into this same container (`container.register({...})`,
 * awilix containers merge) once their classes exist. Registration keys
 * below are copied verbatim from apps/dhow so those waves resolve against
 * the same names without renaming anything here.
 */
export const container = createContainer({
    injectionMode: InjectionMode.PROXY,
    strict: true,
});

container.register({
    // services
    // ---
    cacheService: asClass(RedisCacheService).singleton(),
    pubSubService: asClass(RedisPubSubService).singleton(),
    s3UploadsStorageService: asClass(S3UploadsStorageService).singleton(),
    localUploadsStorageService: asClass(LocalUploadsStorageService).singleton(),

    // policies
    // ---
    usageQuotaPolicy: asClass(RedisUsageQuotaPolicy).singleton(),

    // projects
    // ---
    projectsRepository: asClass(MongodbProjectsRepository).singleton(),

    // project members
    // ---
    projectMembersRepository: asClass(MongoDBProjectMembersRepository).singleton(),

    // api keys
    // ---
    apiKeysRepository: asClass(MongoDBApiKeysRepository).singleton(),

    // assistant templates
    // ---
    assistantTemplatesRepository: asClass(MongoDBAssistantTemplatesRepository).singleton(),

    // data sources
    // ---
    dataSourcesRepository: asClass(MongoDBDataSourcesRepository).singleton(),
    dataSourceDocsRepository: asClass(MongoDBDataSourceDocsRepository).singleton(),

    // jobs
    // ---
    jobsRepository: asClass(MongoDBJobsRepository).singleton(),

    // scheduled job rules
    // ---
    scheduledJobRulesRepository: asClass(MongoDBScheduledJobRulesRepository).singleton(),

    // recurring job rules
    // ---
    recurringJobRulesRepository: asClass(MongoDBRecurringJobRulesRepository).singleton(),

    // composio trigger deployments
    // ---
    composioTriggerDeploymentsRepository: asClass(MongodbComposioTriggerDeploymentsRepository).singleton(),

    // conversations
    // ---
    conversationsRepository: asClass(MongoDBConversationsRepository).singleton(),

    // users
    // ---
    usersRepository: asClass(MongoDBUsersRepository).singleton(),
});
