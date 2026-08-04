import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface DropdownOption {
    key: string;
    label: string;
}

interface DropdownProps {
    options: DropdownOption[];
    value?: string;
    onChange: (value: string) => void;
    className?: string;
    placeholder?: string;
}

export function Dropdown({
    options,
    value,
    onChange,
    className = "w-60",
    placeholder
}: DropdownProps) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger size="sm" className={className}>
                <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
                {options.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
