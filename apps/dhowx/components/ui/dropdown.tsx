import { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Ported from apps/dhow/components/ui/dropdown.tsx, rebuilt on Radix Select
// (components/ui/select.tsx) instead of HeroUI's Select/SelectItem. The
// public API (options/value/onChange) is unchanged.
export interface DropdownOption {
  key: string;
  label: string;
  startContent?: ReactNode;
  endContent?: ReactNode;
}

interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  width?: string | number;
  containerClassName?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function Dropdown({
  options,
  value,
  onChange,
  className = "",
  width = "100%",
  containerClassName = "",
  placeholder,
  disabled,
}: DropdownProps) {
  return (
    <div className={containerClassName} style={{ width }}>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className={className || "w-full"}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {option.startContent && (
                <span className="shrink-0">{option.startContent}</span>
              )}
              {option.label}
              {option.endContent && (
                <span className="shrink-0">{option.endContent}</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
