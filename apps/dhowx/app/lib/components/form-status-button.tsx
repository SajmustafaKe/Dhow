'use client';

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { ButtonHTMLAttributes } from "react";

const variantMap = {
    primary: 'default',
    secondary: 'secondary',
    tertiary: 'ghost',
} as const;

const sizeMap = {
    sm: 'sm',
    md: 'default',
    lg: 'lg',
} as const;

export function FormStatusButton({
    props
}: {
    props: ButtonHTMLAttributes<HTMLButtonElement> & {
        startContent?: React.ReactNode;
        endContent?: React.ReactNode;
        variant?: 'primary' | 'secondary' | 'tertiary';
        size?: 'sm' | 'md' | 'lg';
        isLoading?: boolean;
    };
}) {
    const { pending } = useFormStatus();
    const {
        startContent,
        endContent,
        variant = 'primary',
        size = 'md',
        isLoading,
        disabled,
        children,
        ...rest
    } = props;
    const loading = pending || isLoading;

    return (
        <Button
            variant={variantMap[variant]}
            size={sizeMap[size]}
            disabled={loading || disabled}
            {...rest}
        >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {startContent}
            {children}
            {endContent}
        </Button>
    );
}
