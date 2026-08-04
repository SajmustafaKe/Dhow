'use client';

import { forwardRef, TextareaHTMLAttributes, useCallback, useEffect, useRef } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Send, Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import clsx from 'clsx';

interface TextareaWithSendProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isSubmitting?: boolean;
  submitDisabled?: boolean;
  onImportJson?: () => void;
  importDisabled?: boolean;
  isImporting?: boolean;
  placeholder?: string;
  className?: string;
  rows?: number;
  autoFocus?: boolean;
  autoResize?: boolean;
}

export const TextareaWithSend = forwardRef<HTMLTextAreaElement, TextareaWithSendProps>(
  ({
    value,
    onChange,
    onSubmit,
    isSubmitting = false,
    submitDisabled = false,
    onImportJson,
    importDisabled = false,
    isImporting = false,
    placeholder,
    className,
    rows = 3,
    autoFocus = false,
    autoResize = false,
    ...props
  }, ref) => {
    const hasMore = Boolean(onImportJson);

    // apps/dhow passed `autoResize` to its own bespoke Textarea, which
    // implemented the grow-to-fit behaviour internally. dhowx uses the plain
    // shadcn Textarea, which is a bare <textarea> and has no such prop, so the
    // behaviour lives here instead of reintroducing a second textarea
    // component. Forwarding `autoResize` to a plain <textarea> would also leak
    // an unknown DOM attribute and warn in the console.
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    const setRefs = useCallback((node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    }, [ref]);

    useEffect(() => {
      if (!autoResize) return;
      const el = innerRef.current;
      if (!el) return;
      // Reset before measuring, or scrollHeight only ever grows.
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }, [autoResize, value]);

    return (
      <div className="relative">
        <Textarea
          ref={setRefs}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={clsx(
            // Extra right padding for kebab + send controls
            hasMore ? "pr-24" : "pr-14",
            autoResize && "resize-none overflow-hidden",
            className
          )}
          rows={rows}
          autoFocus={autoFocus}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          {...props}
        />
        <div className="absolute right-3 bottom-3 flex items-center gap-2">
          {hasMore && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={clsx(
                    "rounded-full p-2 transition-all duration-200",
                    "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:scale-105 active:scale-95 hover:bg-gray-200 dark:hover:bg-gray-700"
                  )}
                  aria-label="Add"
                  title="Add"
                >
                  <Plus size={18} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* HeroUI routed clicks through DropdownMenu's onAction(key);
                    Radix puts the handler on the item itself. */}
                <DropdownMenuItem
                  disabled={importDisabled || isImporting}
                  onSelect={() => onImportJson?.()}
                >
                  {isImporting ? 'Importing Assistant (JSON)…' : 'Import Assistant (JSON)'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <button
            onClick={onSubmit}
            disabled={isSubmitting || submitDisabled || !value.trim()}
            className={clsx(
              "rounded-full p-2 transition-all duration-200",
              value.trim()
                ? "bg-indigo-50 hover:bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:hover:bg-indigo-800/60 dark:text-indigo-300"
                : "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500",
              isSubmitting ? "opacity-50" : "hover:scale-105 active:scale-95"
            )}
            aria-label="Send"
            title="Send"
          >
            {isSubmitting ? (
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-current"></div>
            ) : (
              <Send size={18} />
            )}
          </button>
        </div>
      </div>
    );
  }
);

TextareaWithSend.displayName = 'TextareaWithSend';
