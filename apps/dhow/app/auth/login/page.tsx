'use client';

import { useState } from 'react';
import Image from 'next/image';
import { createBrowserClient } from '@supabase/ssr';
import { Button, Spinner } from '@heroui/react';
import logo from '@/public/logo.png';

export default function LoginPage() {
    const [isRedirecting, setIsRedirecting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleGoogleSignIn() {
        setError(null);
        setIsRedirecting(true);

        const supabase = createBrowserClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );

        const { error: signInError } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: `${window.location.origin}/auth/callback`,
            },
        });

        if (signInError) {
            setError(signInError.message);
            setIsRedirecting(false);
        }
        // On success Supabase navigates the browser away to Google, so there
        // is nothing further to do here.
    }

    return (
        <div className="min-h-screen w-full bg-[url('/landing-bg.jpg')] bg-cover bg-center flex flex-col items-center justify-center gap-8 py-10">
            <div className="bg-white/70 backdrop-blur-sm rounded-xl p-10 flex flex-col items-center gap-6 shadow-lg">
                <Image
                    src={logo}
                    alt="Dhow Logo"
                    height={40}
                />
                <Button
                    variant="solid"
                    color="primary"
                    onPress={handleGoogleSignIn}
                    isDisabled={isRedirecting}
                    startContent={isRedirecting ? <Spinner size="sm" /> : undefined}
                >
                    {isRedirecting ? 'Redirecting…' : 'Continue with Google'}
                </Button>
                {error && (
                    <div className="text-sm text-red-500">{error}</div>
                )}
            </div>
        </div>
    );
}
