'use client';
import { useUser } from '@/app/providers/user-provider';
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRouter } from 'next/navigation';

function getInitials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        return '';
    }
    if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function UserButton({ useBilling, collapsed }: { useBilling?: boolean, collapsed?: boolean }) {
    const router = useRouter();
    const { user } = useUser();
    if (!user) {
        return <></>;
    }

    const title = user.email ?? user.name ?? 'Unknown user';
    const name = user.name ?? user.email ?? 'Unknown user';

    return <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <div className="flex items-center gap-2">
                <Avatar className="shrink-0 border rounded-md size-8">
                    <AvatarFallback className="rounded-md text-xs">{getInitials(name)}</AvatarFallback>
                </Avatar>
                {!collapsed && <span className="text-sm truncate">{name}</span>}
            </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
            <DropdownMenuLabel>{title}</DropdownMenuLabel>
            {useBilling && (
                <DropdownMenuItem onClick={() => router.push('/billing')}>
                    Billing
                </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => router.push('/auth/logout')}>
                Logout
            </DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>
}
