'use client';

import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { CustomMcpServers } from './CustomMcpServer';
import { SelectComposioToolkit } from './SelectComposioToolkit';
import { ComposioToolsPanel } from './ComposioToolsPanel';
import { AddWebhookTool } from './AddWebhookTool';
import { Workflow, WorkflowTool } from '@/app/lib/types/workflow_types';
import { ZToolkit } from "@/src/application/lib/composio/types";
import { z } from 'zod';

interface ToolsConfigProps {
  projectId: string;
  useComposioTools: boolean;
  tools: z.infer<typeof Workflow.shape.tools>;
  onAddTool: (tool: Partial<z.infer<typeof WorkflowTool>>) => void;
  initialToolkitSlug?: string | null;
}

type ToolkitType = z.infer<typeof ZToolkit>;

export function ToolsConfig({
  projectId,
  useComposioTools,
  tools,
  onAddTool,
  initialToolkitSlug
}: ToolsConfigProps) {
  let defaultActiveTab = 'mcp';
  if (useComposioTools) {
    defaultActiveTab = 'composio';
  }
  const [activeTab, setActiveTab] = useState(defaultActiveTab);
  const [selectedToolkit, setSelectedToolkit] = useState<ToolkitType | null>(null);
  const [isToolsPanelOpen, setIsToolsPanelOpen] = useState(false);
  const useBilling = process.env.NEXT_PUBLIC_USE_BILLING === "true";

  const handleTabChange = (key: string) => {
    setActiveTab(key);
  };

  const handleSelectToolkit = (toolkit: ToolkitType) => {
    setSelectedToolkit(toolkit);
    setIsToolsPanelOpen(true);
  };

  const handleCloseToolsPanel = () => {
    setSelectedToolkit(null);
    setIsToolsPanelOpen(false);
  };

  const handleAddTool = (tool: z.infer<typeof WorkflowTool>) => {
    onAddTool(tool);
    handleCloseToolsPanel();
  };

  return (
    <div className="h-full flex flex-col">
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        aria-label="Tool configuration options"
        className="w-full"
      >
        <TabsList className="w-full">
          {useComposioTools && (
            <TabsTrigger value="composio">Library</TabsTrigger>
          )}
          <TabsTrigger value="mcp">Custom MCP Servers</TabsTrigger>
          {!useBilling && <TabsTrigger value="webhook">Webhook</TabsTrigger>}
        </TabsList>
        {useComposioTools && (
          <TabsContent value="composio">
            <div className="mt-4 p-6">
              <SelectComposioToolkit
                projectId={projectId}
                tools={tools}
                onSelectToolkit={handleSelectToolkit}
                initialToolkitSlug={initialToolkitSlug}
                filterByTools={true}
              />
            </div>
          </TabsContent>
        )}
        <TabsContent value="mcp">
          <div className="mt-4 p-6">
            <CustomMcpServers
              tools={tools}
              onAddTool={onAddTool}
            />
          </div>
        </TabsContent>
        {!useBilling && (
          <TabsContent value="webhook">
            <div className="mt-4 p-6">
              <AddWebhookTool
                projectId={projectId}
                onAddTool={onAddTool}
              />
            </div>
          </TabsContent>
        )}
      </Tabs>
      
      {/* Tools Panel */}
      {selectedToolkit && (
        <ComposioToolsPanel
          toolkit={selectedToolkit}
          isOpen={isToolsPanelOpen}
          onClose={handleCloseToolsPanel}
          tools={tools}
          onAddTool={handleAddTool}
        />
      )}
    </div>
  );
} 
