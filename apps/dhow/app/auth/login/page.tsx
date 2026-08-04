'use client';

import { useState } from 'react';
import Image from 'next/image';
import { createBrowserClient } from '@supabase/ssr';
import { Button, Input, Spinner } from '@heroui/react';
import logo from '@/public/logo.png';

/**
 * Replaces Auth0's hosted Universal Login, which the SDK used to generate.
 *
 * Email magic link, because that is what the project actually has enabled:
 * `GET /auth/v1/settings` on the live tenant reports `external: ["email"]` and
 * nothing else. An earlier revision of this page offered only "Continue with
 * Google" — that button would have failed on click, because Google is not
 * configured as a provider.
 *
 * To add Google later: enable it in Authentication -> Providers, then call
 * `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } })`
 * from a second button. The callback route already handles both, since the code
 * exchange is provider-agnostic.
 */
export default function LoginPage() {
    const [email, setEmail] = useState('');
    const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
    const [error, setError] = useState<string | null>(null);

    async function handleEmailSignIn() {
        const trimmed = email.trim();
        if (!trimmed) {
            setError('Enter your email address.');
            return;
        }

        setError(null);
        setStatus('sending');

        const supabase = createBrowserClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
        );

        const { error: signInError } = await supabase.auth.signInWithOtp({
            email: trimmed,
            options: {
                // Must be on the project's redirect allowlist (supabase/config.toml,
                // additional_redirect_urls) or the link in the email is refused.
                emailRedirectTo: `${window.location.origin}/auth/callback`,
            },
        });

        if (signInError) {
            setError(signInError.message);
            setStatus('idle');
            return;
        }

        setStatus('sent');
    }

    return (
        <div className="min-h-screen w-full bg-[url('/landing-bg.jpg')] bg-cover bg-center flex flex-col items-center justify-center gap-8 py-10">
            <div className="bg-white/70 backdrop-blur-sm rounded-xl p-10 flex flex-col items-center gap-6 shadow-lg w-full max-w-sm">
                <Image src={logo} alt="Dhow Logo" height={40} />

                {status === 'sent' ? (
                    <div className="text-center flex flex-col gap-2">
                        <div className="text-sm font-medium">Check your email</div>
                        <div className="text-sm text-gray-600">
                            We sent a sign-in link to {email.trim()}.
                        </div>
                    </div>
                ) : (
                    <>
                        <Input
                            type="email"
                            label="Email"
                            value={email}
                            onValueChange={setEmail}
                            isDisabled={status === 'sending'}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleEmailSignIn();
                            }}
                        />
                        <Button
                            variant="solid"
                            color="primary"
                            className="w-full"
                            onPress={handleEmailSignIn}
                            isDisabled={status === 'sending'}
                            startContent={status === 'sending' ? <Spinner size="sm" /> : undefined}
                        >
                            {status === 'sending' ? 'Sending…' : 'Send sign-in link'}
                        </Button>
                    </>
                )}

                {error && <div className="text-sm text-red-500">{error}</div>}
            </div>
        </div>
    );
}
