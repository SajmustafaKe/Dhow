'use client';
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface FeedbackModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (feedback: string) => void;
    title?: string;
}

export function FeedbackModal({ isOpen, onClose, onSubmit, title = "Provide Feedback" }: FeedbackModalProps) {
    const [feedback, setFeedback] = useState("");

    const handleSubmit = () => {
        onSubmit(feedback);
        setFeedback("");
        onClose();
    };

    const handleCancel = () => {
        setFeedback("");
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleCancel(); }}>
            <DialogContent className="feedback-modal sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {title}
                    </DialogTitle>
                </DialogHeader>
                <p className="text-xs text-gray-600 dark:text-gray-400 -mt-2">
                    Tell Skipper what needs to be fixed
                </p>
                <div className="space-y-3">
                    <Textarea
                        placeholder="Describe the issue..."
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        rows={3}
                        className="w-full !text-xs max-h-36 overflow-y-auto focus:ring-0 focus:shadow-none focus:border-gray-300"
                    />
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={handleCancel}>
                        Cancel
                    </Button>
                    <Button onClick={handleSubmit}>
                        Submit
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
