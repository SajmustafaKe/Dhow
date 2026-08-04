'use client';

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Server, MoreVertical } from 'lucide-react';
import { Workflow, WorkflowTool } from '@/app/lib/types/workflow_types';
import { fetchTools } from "@/app/actions/custom-mcp-server.actions";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

type ServerCardProps = {
  serverName: string;
  serverUrl: string;
  workflowTools: z.infer<typeof Workflow.shape.tools>;
  onSelectServer: () => void;
  onDeleteServer: () => void;
};

const serverCardStyles = {
    base: clsx(
        "group p-6 rounded-xl transition-all duration-200 cursor-pointer",
        "bg-white dark:bg-gray-900",
        "border border-gray-200 dark:border-gray-700",
        "shadow-md dark:shadow-gray-900/20",
        "hover:shadow-lg dark:hover:shadow-gray-900/30",
        "hover:border-blue-300 dark:hover:border-blue-600",
        "hover:bg-gray-50/50 dark:hover:bg-gray-800/50",
        "hover:-translate-y-1",
        "min-h-[200px] flex flex-col"
    ),
};

export function ServerCard({ 
  serverName, 
  serverUrl, 
  workflowTools,
  onSelectServer,
  onDeleteServer,
}: ServerCardProps) {
  const [tools, setTools] = useState<z.infer<typeof WorkflowTool>[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsError, setToolsError] = useState<string | null>(null);

  // Fetch tools on mount
  useEffect(() => {
    const fetchServerTools = async () => {
      setToolsLoading(true);
      setToolsError(null);
      try {
        const fetched = await fetchTools(serverUrl, serverName);
        setTools(fetched);
      } catch (err) {
        setToolsError(err instanceof Error ? err.message : 'Failed to fetch tools');
        setTools([]);
      } finally {
        setToolsLoading(false);
      }
    };

    fetchServerTools();
  }, [serverUrl, serverName]);

  const handleCardClick = useCallback(() => {
    onSelectServer();
  }, [onSelectServer]);

  // Calculate selected tools count for this server
  const selectedToolsCount = workflowTools
    .filter(tool => tool.isMcp && tool.mcpServerName === serverName)
    .length;

  return (
    <div className={serverCardStyles.base} onClick={handleCardClick}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-start gap-3 mb-4">
          <div className="w-8 h-8 bg-blue-500 rounded-md flex items-center justify-center flex-shrink-0">
            <Server className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg text-gray-900 dark:text-gray-100 truncate">
              {serverName}
            </h3>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {toolsLoading ? (
                <Badge variant="secondary">
                  Loading tools...
                </Badge>
              ) : toolsError ? (
                <Badge variant="destructive">
                  Error loading tools
                </Badge>
              ) : (
                <Badge variant="secondary">
                  {selectedToolsCount > 0 
                    ? `${tools.length} tools, ${selectedToolsCount} selected`
                    : `${tools.length} tools`
                  }
                </Badge>
              )}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button 
                variant="ghost" 
                size="icon-sm" 
                title="More options"
                aria-label="More options"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent aria-label="Server actions">
              <DropdownMenuItem
                variant="destructive"
                onSelect={onDeleteServer}
              >
                <MoreVertical className="h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        
        {/* Description */}
        <div className="flex-1">
          <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-3">
            Custom MCP server at {serverUrl}
          </p>
        </div>

        {/* Footer */}
        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300"
              >
                Custom Server
              </Badge>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
} 
