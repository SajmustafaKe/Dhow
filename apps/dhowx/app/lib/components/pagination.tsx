'use client';

import { usePathname, useRouter } from "next/navigation";
import {
    Pagination as PaginationRoot,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from "@/components/ui/pagination";

/** Page numbers to render, with `"ellipsis"` marking a gap. Always includes 1 and `total`. */
function getPageRange(current: number, total: number, siblingCount = 1): (number | "ellipsis")[] {
    const totalVisible = siblingCount * 2 + 5; // first + last + current + 2 ellipses worth of siblings
    if (totalVisible >= total) {
        return Array.from({ length: total }, (_, i) => i + 1);
    }

    const leftSibling = Math.max(current - siblingCount, 1);
    const rightSibling = Math.min(current + siblingCount, total);
    const showLeftEllipsis = leftSibling > 2;
    const showRightEllipsis = rightSibling < total - 1;

    if (!showLeftEllipsis && showRightEllipsis) {
        const leftItemCount = 3 + siblingCount * 2;
        return [...Array.from({ length: leftItemCount }, (_, i) => i + 1), "ellipsis", total];
    }
    if (showLeftEllipsis && !showRightEllipsis) {
        const rightItemCount = 3 + siblingCount * 2;
        return [1, "ellipsis", ...Array.from({ length: rightItemCount }, (_, i) => total - rightItemCount + i + 1)];
    }
    return [1, "ellipsis", ...Array.from({ length: rightSibling - leftSibling + 1 }, (_, i) => leftSibling + i), "ellipsis", total];
}

export function Pagination({
    total,
    page,
    onChange,
}: {
    total: number;
    page: number;
    onChange?: (page: number) => void;
}) {
    const pathname = usePathname();
    const router = useRouter();

    const goToPage = (newPage: number) => {
        if (newPage < 1 || newPage > total || newPage === page) {
            return;
        }
        if (onChange) {
            onChange(newPage);
        } else {
            router.push(`${pathname}?page=${newPage}`);
        }
    };

    const pageNumbers = getPageRange(page, total);

    return (
        <PaginationRoot>
            <PaginationContent>
                <PaginationItem>
                    <PaginationPrevious
                        href="#"
                        aria-disabled={page <= 1}
                        className={page <= 1 ? "pointer-events-none opacity-50" : undefined}
                        onClick={(e) => {
                            e.preventDefault();
                            goToPage(page - 1);
                        }}
                    />
                </PaginationItem>
                {pageNumbers.map((p, i) =>
                    p === "ellipsis" ? (
                        <PaginationItem key={`ellipsis-${i}`}>
                            <PaginationEllipsis />
                        </PaginationItem>
                    ) : (
                        <PaginationItem key={p}>
                            <PaginationLink
                                href="#"
                                isActive={p === page}
                                onClick={(e) => {
                                    e.preventDefault();
                                    goToPage(p);
                                }}
                            >
                                {p}
                            </PaginationLink>
                        </PaginationItem>
                    )
                )}
                <PaginationItem>
                    <PaginationNext
                        href="#"
                        aria-disabled={page >= total}
                        className={page >= total ? "pointer-events-none opacity-50" : undefined}
                        onClick={(e) => {
                            e.preventDefault();
                            goToPage(page + 1);
                        }}
                    />
                </PaginationItem>
            </PaginationContent>
        </PaginationRoot>
    );
}
