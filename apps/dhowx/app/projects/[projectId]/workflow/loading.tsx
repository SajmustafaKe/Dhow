"use client";
import { Spinner } from "@/app/lib/components/spinner";

export default function Loading() {
    return <div className="flex flex-col gap-4">
        <Spinner size="sm" />
    </div>;
}
