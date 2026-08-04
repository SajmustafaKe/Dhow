'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/app/lib/components/spinner";
import { AlertTriangle } from "lucide-react";

export interface ProjectWideChangeConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  confirmationQuestion: string;
  confirmButtonText?: string;
  isLoading?: boolean;
  disabled?: boolean;
}

export function ProjectWideChangeConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  confirmationQuestion,
  confirmButtonText = "Confirm",
  isLoading = false,
  disabled = false,
}: ProjectWideChangeConfirmationModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-orange-600" />
              <span>{title}</span>
            </div>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {confirmationQuestion}
          </p>

          <div className="bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center text-xs font-medium text-white mt-0.5">
                ⚠️
              </div>
              <div className="text-sm">
                <p className="font-medium text-orange-800 dark:text-orange-200 mb-1">
                  This change will affect the deployed (Live) workflow as well!
                </p>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={disabled || isLoading}
          >
            {isLoading && <Spinner size="sm" className="mr-2 h-4 w-4" />}
            {confirmButtonText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
