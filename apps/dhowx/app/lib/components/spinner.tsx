import { Loader2 } from "lucide-react";
import clsx from "clsx";

const sizeClasses = {
    sm: "h-4 w-4",
    md: "h-6 w-6",
    lg: "h-8 w-8",
} as const;

const colorClasses = {
    default: "text-gray-400 dark:text-gray-500",
    primary: "text-blue-600 dark:text-blue-400",
    warning: "text-amber-500 dark:text-amber-400",
    success: "text-green-600 dark:text-green-400",
    danger: "text-red-600 dark:text-red-400",
} as const;

/**
 * Shared loading spinner. Replaces HeroUI's `Spinner` — every port slice should
 * import this instead of inlining `lucide-react`'s `Loader2` with `animate-spin`.
 */
export function Spinner({
    size = "md",
    color = "default",
    className,
}: {
    size?: "sm" | "md" | "lg";
    color?: "default" | "primary" | "warning" | "success" | "danger";
    className?: string;
}) {
    return (
        <Loader2
            className={clsx("animate-spin", sizeClasses[size], colorClasses[color], className)}
            aria-hidden="true"
        />
    );
}
