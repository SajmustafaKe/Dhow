'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { createBrowserClient } from '@supabase/ssr';

interface AppUser {
    id: string;
    email?: string;
    name?: string;
}

interface UserContextValue {
    user: AppUser | null;
    isLoading: boolean;
}

const UserContext = createContext<UserContextValue>({ user: null, isLoading: true });

interface SupabaseUserLike {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
}

function toAppUser(supabaseUser: SupabaseUserLike | null | undefined): AppUser | null {
    if (!supabaseUser) {
        return null;
    }
    // Mirrors app/lib/supabase.ts's getSession(): only `user_metadata.name`
    // is treated as a display name, so server- and client-rendered names
    // never disagree.
    const metadata = supabaseUser.user_metadata ?? {};
    return {
        id: supabaseUser.id,
        email: supabaseUser.email,
        name: typeof metadata.name === "string" ? metadata.name : undefined,
    };
}

/**
 * Client-side auth state provider backed by Supabase Auth (GoTrue).
 *
 * Unlike Auth0's `Auth0Provider`, `@supabase/ssr` needs no React context for
 * server components -- this provider exists only so client components can
 * read the current user reactively (e.g. for a top bar avatar) without each
 * one standing up its own browser client and `onAuthStateChange` listener.
 */
export function UserProvider({ children }: { children: ReactNode }) {
    const [supabase] = useState(() => createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    ));
    const [user, setUser] = useState<AppUser | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let active = true;

        supabase.auth.getUser().then(({ data }) => {
            if (!active) return;
            setUser(toAppUser(data.user));
            setIsLoading(false);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            if (!active) return;
            setUser(toAppUser(session?.user ?? null));
            setIsLoading(false);
        });

        return () => {
            active = false;
            subscription.unsubscribe();
        };
    }, [supabase]);

    return (
        <UserContext.Provider value={{ user, isLoading }}>
            {children}
        </UserContext.Provider>
    );
}

export function useUser(): UserContextValue {
    return useContext(UserContext);
}
