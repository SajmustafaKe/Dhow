'use client';

import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ToolsConfig } from '../../tools/components/ToolsConfig';
import { z } from 'zod';
import { Workflow, WorkflowTool } from '@/app/lib/types/workflow_types';

interface ToolsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  tools: z.infer<typeof Workflow.shape.tools>;
  onAddTool: (tool: Partial<z.infer<typeof WorkflowTool>>) => void;
  initialToolkitSlug?: string | null;
}

export function ToolsModal({
  isOpen,
  onClose,
  projectId,
  tools,
  onAddTool,
  initialToolkitSlug
}: ToolsModalProps) {
  function handleAddTool(tool: Partial<z.infer<typeof WorkflowTool>>) {
    onAddTool(tool);
    onClose();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            Add tools
          </DialogTitle>
        </DialogHeader>
        <ToolsConfig
          useComposioTools={true}
          projectId={projectId}
          tools={tools}
          onAddTool={handleAddTool}
          initialToolkitSlug={initialToolkitSlug}
        />
      </DialogContent>
    </Dialog>
  );
}
