'use client';
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyIcon, CheckIcon } from "lucide-react";
import { useState } from "react";

export function CopyButton({
    onCopy,
    label,
    successLabel,
}: {
    onCopy: () => void;
    label: string;
    successLabel: string;
}) {
    const [showCopySuccess, setShowCopySuccess] = useState(false);

    const handleCopy = () => {
        onCopy();
        setShowCopySuccess(true);
        setTimeout(() => {
            setShowCopySuccess(false);
        }, 500);
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleCopy}
                    className="gap-2"
                >
                    {showCopySuccess ? (
                        <CheckIcon className="h-4 w-4" />
                    ) : (
                        <CopyIcon className="h-4 w-4" />
                    )}
                </Button>
            </TooltipTrigger>
            <TooltipContent>{showCopySuccess ? successLabel : label}</TooltipContent>
        </Tooltip>
    );
}
