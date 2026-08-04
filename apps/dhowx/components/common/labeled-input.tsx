import { clsx } from "clsx";
import { InputHTMLAttributes, forwardRef } from "react";

// Ported from apps/dhow/components/ui/input.tsx.
// NOT the shadcn Input at components/ui/input.tsx — that one is a bare
// <input>. This wraps it with an optional label + inline error message,
// which dhow's onboarding flow and other forms depend on. Renamed to avoid
// the filename collision; plain callers (no label/error) should keep using
// the shadcn Input directly.
interface LabeledInputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string;
}

export const Input = forwardRef<HTMLInputElement, LabeledInputProps>(({
  className,
  error,
  label,
  ...props
}, ref) => {
  return (
    <div className="space-y-2">
      {label && (
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </label>
      )}
      <input
        ref={ref}
        className={clsx(
          "flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2",
          "text-sm placeholder:text-gray-400",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100",
          error && "border-red-500 focus-visible:ring-red-500",
          className
        )}
        {...props}
      />
      {error && (
        <p className="text-sm text-red-500">{error}</p>
      )}
    </div>
  );
});

Input.displayName = "LabeledInput";
