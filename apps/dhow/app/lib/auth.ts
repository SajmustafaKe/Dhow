import { z } from "zod";
import { getSession } from "./supabase";
import { User } from "@/src/entities/models/user";
import { USE_AUTH } from "./feature_flags";
import { redirect } from "next/navigation";
import { container } from "@/di/container";
import { IUsersRepository } from "@/src/application/repositories/users.repository.interface";

export const GUEST_SESSION = {
    email: "guest@dhow.local",
    email_verified: true,
    sub: "guest_user",
}

export const GUEST_DB_USER: z.infer<typeof User> = {
    id: "guest_user",
    authId: "guest_user",
    name: "Guest",
    email: "guest@dhow.local",
    createdAt: new Date().toISOString(),
}

/**
 * This function should be used as an initial check in server page components to ensure
 * the user is authenticated. It will:
 * 1. Check for a valid user session
 * 2. Redirect to login if no session exists
 * 3. Return the authenticated user
 *
 * Usage in server components:
 * ```ts
 * const user = await requireAuth();
 * ```
 */
export async function requireAuth(): Promise<z.infer<typeof User>> {
    if (!USE_AUTH) {
        return GUEST_DB_USER;
    }

    const { user } = await getSession() || {};
    if (!user) {
        redirect('/auth/login');
    }

    // fetch db user
    const usersRepository = container.resolve<IUsersRepository>("usersRepository");
    let dbUser = await getUserFromSessionId(user.id);

    // if db user does not exist, create one
    if (!dbUser) {
        dbUser = await usersRepository.create({
            authId: user.id,
            email: user.email,
        });
        console.log(`created new user id ${dbUser.id} for session id ${user.id}`);
    }

    return dbUser;
}

export async function getUserFromSessionId(sessionUserId: string): Promise<z.infer<typeof User> | null> {
    if (!USE_AUTH) {
        return GUEST_DB_USER;
    }

    const usersRepository = container.resolve<IUsersRepository>("usersRepository");
    return await usersRepository.fetchByAuthId(sessionUserId);
}