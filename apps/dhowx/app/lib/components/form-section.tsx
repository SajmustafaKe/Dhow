import { Separator } from "@/components/ui/separator";
import { Label } from "./label";

export function FormSection({
    label,
    children,
    showDivider = false,
}: {
    label?: string;
    children: React.ReactNode;
    showDivider?: boolean;
}) {
    return (
        <>
            <div className="flex flex-col gap-2">
                {label && <Label label={label} />}
                {children}
            </div>
            {showDivider && <Separator className="my-4" />}
        </>
    );
} 
