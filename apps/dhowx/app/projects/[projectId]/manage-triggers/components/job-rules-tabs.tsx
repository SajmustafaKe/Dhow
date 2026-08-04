'use client';

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScheduledJobRulesList } from "../scheduled/components/scheduled-job-rules-list";
import { RecurringJobRulesList } from "./recurring-job-rules-list";
import { TriggersTab } from "./triggers-tab";

export function JobRulesTabs({ projectId }: { projectId: string }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const initialTab = (searchParams.get('tab') ?? 'triggers');
    const [activeTab, setActiveTab] = useState<string>(initialTab);

    const handleTabChange = (nextTab: string) => {
        setActiveTab(nextTab);
        const params = new URLSearchParams(searchParams.toString());
        params.set('tab', nextTab);
        router.replace(`${pathname}?${params.toString()}`);
    };

    useEffect(() => {
        const current = searchParams.get('tab') ?? 'triggers';
        if (current !== activeTab) {
            setActiveTab(current);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    return (
        <div className="h-full flex flex-col">
            <Tabs
                value={activeTab}
                onValueChange={handleTabChange}
                aria-label="Job Rules"
                className="h-full"
            >
                <TabsList className="w-full">
                    <TabsTrigger value="triggers">External Triggers</TabsTrigger>
                    <TabsTrigger value="scheduled">One-Time Triggers</TabsTrigger>
                    <TabsTrigger value="recurring">Recurring Triggers</TabsTrigger>
                </TabsList>
                <TabsContent value="triggers">
                    <TriggersTab projectId={projectId} />
                </TabsContent>
                <TabsContent value="scheduled">
                    <ScheduledJobRulesList projectId={projectId} />
                </TabsContent>
                <TabsContent value="recurring">
                    <RecurringJobRulesList projectId={projectId} />
                </TabsContent>
            </Tabs>
        </div>
    );
}
