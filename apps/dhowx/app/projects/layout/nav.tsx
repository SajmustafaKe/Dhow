'use client';
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import Link from "next/link";
import { useEffect, useState } from "react";
import clsx from "clsx";
import Menu from "./menu";
import { fetchProject } from "@/app/actions/project.actions";
import { FolderOpenIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";

export function Nav({
    projectId,
}: {
    projectId: string;
}) {
    const [collapsed, setCollapsed] = useState(false);
    const [projectName, setProjectName] = useState<string | null>(null);

    useEffect(() => {
        async function getProject() {
            const project = await fetchProject(projectId);
            setProjectName(project.name);
        }
        getProject();
    }, [projectId]);

    function toggleCollapse() {
        setCollapsed(!collapsed);
    }

    return <div className={clsx("shrink-0 flex flex-col gap-2 border-r border relative p-2", {
        "w-40": !collapsed,
        "w-10": collapsed
    })}>
        <Tooltip>
            <TooltipTrigger asChild>
                <button onClick={toggleCollapse} className="absolute bottom-[50px] right-2 text-gray-400 hover:text-black w-[28px] h-[28px]">
                    {!collapsed && <PanelLeftCloseIcon size={16} className="m-auto" />}
                    {collapsed && <PanelLeftOpenIcon size={16} className="m-auto" />}
                </button>
            </TooltipTrigger>
            <TooltipContent side="right">{collapsed ? "Expand" : "Collapse"}</TooltipContent>
        </Tooltip>
        {!collapsed && <div className="flex flex-col gap-1">
            <Tooltip>
                <TooltipTrigger asChild>
                    <Link className="relative group flex flex-col px-2 py-2 border border-gray-200 rounded-md hover:border-gray-500 transition-colors duration-100" href="/projects">
                        <div className="flex flex-row items-center gap-2">
                            <FolderOpenIcon size={16} />
                            <div className="truncate text-sm">
                                {projectName || projectId}
                            </div>
                        </div>
                    </Link>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end">Change project</TooltipContent>
            </Tooltip>
        </div>}
        {collapsed && <Tooltip>
            <TooltipTrigger asChild>
                <Link href="/projects">
                    <FolderOpenIcon size={16} className="ml-1" />
                </Link>
            </TooltipTrigger>
            <TooltipContent side="right">Change project</TooltipContent>
        </Tooltip>}
        <Menu projectId={projectId} collapsed={collapsed} />
    </div>;
}