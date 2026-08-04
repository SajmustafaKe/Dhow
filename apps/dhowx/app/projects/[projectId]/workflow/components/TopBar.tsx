"use client";
import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { RadioIcon, RedoIcon, UndoIcon, RocketIcon, PenLine, AlertTriangle, DownloadIcon, SettingsIcon, ChevronDownIcon, ZapIcon, Plug, MessageCircleIcon, ShareIcon } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { ProgressBar, ProgressStep } from "@/components/ui/progress-bar";
import { Spinner } from "@/app/lib/components/spinner";
import { useUser } from '@/app/providers/user-provider';
import { SHOW_COMMUNITY_PUBLISH } from "@/app/lib/feature_flags";

interface CommunityData {
    name: string;
    description: string;
    category: string;
    tags: string[];
    isAnonymous: boolean;
    copilotPrompt: string;
}

interface TopBarProps {
    localProjectName: string;
    projectNameError: string | null;
    onProjectNameChange: (value: string) => void;
    onProjectNameCommit: (value: string) => Promise<void>;
    publishing: boolean;
    isLive: boolean;
    autoPublishEnabled: boolean;
    onToggleAutoPublish: (enabled: boolean) => void;
    showCopySuccess: boolean;
    showBuildModeBanner: boolean;
    canUndo: boolean;
    canRedo: boolean;
    activePanel: 'playground' | 'copilot';
    viewMode: "two_agents_chat" | "two_agents_skipper" | "two_chat_skipper" | "three_all";
    hasAgentInstructionChanges: boolean;
    hasPlaygroundTested: boolean;
    hasPublished: boolean;
    hasClickedUse: boolean;
    onUndo: () => void;
    onRedo: () => void;
    onDownloadJSON: () => void;
    onPublishWorkflow: () => void;
    onChangeMode: (mode: 'draft' | 'live') => void;
    onRevertToLive: () => void;
    onTogglePanel: () => void;
    onSetViewMode: (mode: "two_agents_chat" | "two_agents_skipper" | "two_chat_skipper" | "three_all") => void;
    hasAgents?: boolean;
    onUseAssistantClick: () => void;
    onStartNewChatAndFocus: () => void;
    onStartBuildTour?: () => void;
    onStartTestTour?: () => void;
    onStartUseTour?: () => void;
    onShareWorkflow: () => void;
    shareUrl: string | null;
    onCopyShareUrl: () => void;
    shareMode: 'url' | 'community';
    setShareMode: (mode: 'url' | 'community') => void;
    communityData: CommunityData;
    setCommunityData: (data: CommunityData) => void;
    onCommunityPublish: () => void;
    communityPublishing: boolean;
    communityPublishSuccess: boolean;
}

export function TopBar({
    localProjectName,
    projectNameError,
    onProjectNameChange,
    onProjectNameCommit,
    publishing,
    isLive,
    autoPublishEnabled,
    onToggleAutoPublish,
    showCopySuccess,
    showBuildModeBanner,
    canUndo,
    canRedo,
    viewMode,
    hasAgentInstructionChanges,
    hasPlaygroundTested,
    hasClickedUse,
    onUndo,
    onRedo,
    onDownloadJSON,
    onPublishWorkflow,
    onChangeMode,
    onRevertToLive,
    onSetViewMode,
    hasAgents = true,
    onUseAssistantClick,
    onStartNewChatAndFocus,
    onStartBuildTour,
    onStartTestTour,
    onStartUseTour,
    onShareWorkflow,
    shareUrl,
    onCopyShareUrl,
    communityData,
    setCommunityData,
    onCommunityPublish,
    communityPublishing,
    communityPublishSuccess,
}: TopBarProps) {
    const router = useRouter();
    const params = useParams();
    const projectIdParam = params?.projectId;
    const projectId = typeof projectIdParam === 'string' ? projectIdParam : projectIdParam?.[0];

    // Share modal state
    const [isShareModalOpen, setIsShareModalOpen] = useState(false);
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const onShareModalClose = useCallback(() => setIsShareModalOpen(false), []);
    const onConfirmClose = () => setIsConfirmOpen(false);
    const [acknowledged, setAcknowledged] = useState(false);
    const [copyButtonText, setCopyButtonText] = useState('Copy');

    const handleShareClick = () => {
        onShareWorkflow(); // Call the original share function to generate URL
        setIsShareModalOpen(true); // Open the modal
    };

    const handleCopyUrl = () => {
        onCopyShareUrl(); // Call the original copy function
        setCopyButtonText('Copied!');
        setTimeout(() => {
            setCopyButtonText('Copy');
        }, 2000); // Reset after 2 seconds
    };

    // After successful community publish, briefly show success and then close modal
    useEffect(() => {
        if (communityPublishSuccess) {
            const timer = setTimeout(() => {
                onShareModalClose();
            }, 1200);
            return () => clearTimeout(timer);
        }
    }, [communityPublishSuccess, onShareModalClose]);

    const { user } = useUser();

    const getUserDisplayName = () => {
        if (!user) return 'Anonymous';
        return user.name ?? user.email ?? 'Anonymous';
    };

    // Progress bar steps with completion logic and current step detection
    const step1Complete = hasAgentInstructionChanges;
    const step2Complete = hasPlaygroundTested && hasAgentInstructionChanges;
    // Keep publish as a prerequisite for Use completion, but remove it from the visual steps
    // Mark "Use" complete as soon as a Use Assistant option is clicked
    const step4Complete = hasClickedUse;

    // Determine current step (first incomplete visual step: 1 -> 2 -> 4)
    const currentStep = !step1Complete ? 1 : !step2Complete ? 2 : !step4Complete ? 4 : null;

    const progressSteps: ProgressStep[] = [
        { id: 1, label: "Build: Ask the copilot to create your assistant. Add tools and connect data sources.", completed: step1Complete, isCurrent: currentStep === 1 },
        { id: 2, label: "Test: Test out your assistant by chatting with it. Use 'Fix' and 'Explain' to improve it.", completed: step2Complete, isCurrent: currentStep === 2 },
        // Removed the 'Publish' step from the progress bar
        { id: 4, label: "Use: Click the 'Use Assistant' button to chat, set triggers (like emails), or connect via API.", completed: step4Complete, isCurrent: currentStep === 4 },
    ];

    return (
        <>
        <div className="rounded-xl bg-white/70 dark:bg-zinc-800/70 shadow-sm backdrop-blur-sm border border-zinc-200 dark:border-zinc-800 px-5 py-2">
            <div className="flex justify-between items-center">
                <div className="workflow-version-selector flex items-center gap-3 -ml-1 pr-2 text-gray-800 dark:text-gray-100">
                    {/* Project Name Editor */}
                    <div className="flex flex-col min-w-0 max-w-xs">
                        <Input
                            type="text"
                            value={localProjectName}
                            onChange={(e) => onProjectNameChange(e.target.value)}
                            onBlur={() => onProjectNameCommit(localProjectName)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.currentTarget.blur();
                                }
                            }}
                            aria-invalid={!!projectNameError}
                            placeholder="Project name..."
                            className="h-9 min-h-[36px] text-sm font-semibold px-2 border-gray-200 dark:border-gray-700"
                        />
                        {projectNameError && (
                            <p className="mt-1 text-xs text-red-500">{projectNameError}</p>
                        )}
                    </div>

                    {/* Mode pill and auto-publish checkbox */}
                    <div className="h-4 w-px bg-gray-300 dark:bg-gray-600"></div>

                    {/* Mode pill */}
                    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 font-medium text-xs rounded-full">
                        <RadioIcon size={12} />
                        <span>
                            {autoPublishEnabled ? 'Live ' : (isLive ? 'Live ' : 'Draft')}
                        </span>
                    </div>

                    {/* Auto-publish checkbox or Switch to draft button */}
                    {!autoPublishEnabled && isLive ? (
                        <Button
                            variant="default"
                            size="sm"
                            onClick={() => onChangeMode('draft')}
                            className="gap-2 px-3 h-8 bg-gray-100 hover:bg-gray-200 text-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300 font-medium text-sm border border-gray-200 dark:border-gray-600 shadow-sm"
                        >
                            <PenLine size={14} />
                            Switch to draft
                        </Button>
                    ) : (
                        !isLive && (
                            <div className="flex items-center">
                                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                                    <Checkbox
                                        checked={autoPublishEnabled}
                                        onCheckedChange={(checked) => onToggleAutoPublish(checked === true)}
                                    />
                                    Auto-publish
                                </label>
                            </div>
                        )
                    )}
                </div>

                {/* Progress Bar - Center */}
                <div className="flex-1 flex justify-center">
                    <ProgressBar 
                        steps={progressSteps}
                        onStepClick={(step) => {
                            if (step.id === 1 && onStartBuildTour) onStartBuildTour();
                            if (step.id === 2 && onStartTestTour) onStartTestTour();
                            if (step.id === 4 && onStartUseTour) onStartUseTour();
                        }}
                    />
                </div>

                {/* Right side buttons */}
                <div className="flex items-center gap-2">
                    {showCopySuccess && <div className="flex items-center gap-2 mr-4">
                        <div className="text-green-500">Copied to clipboard</div>
                    </div>}
                    
                    {showBuildModeBanner && <div className="flex items-center gap-2 mr-4">
                        <AlertTriangle className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                        <div className="text-blue-700 dark:text-blue-300 text-sm">
                            Switched to draft mode. You can now make changes to your workflow.
                        </div>
                    </div>}
                    
                    
                    {!isLive && <div className="flex items-center gap-0.5">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={onUndo}
                            disabled={!canUndo}
                            className="group min-w-8 h-8 px-2 bg-gray-50 text-gray-700 hover:bg-gray-100 disabled:bg-gray-25 disabled:text-gray-400"
                        >
                            <span className="group-hover:hidden inline-flex"><UndoIcon className="w-3.5 h-3.5" /></span>
                            <span className="hidden group-hover:inline">Undo</span>
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={onRedo}
                            disabled={!canRedo}
                            className="group min-w-8 h-8 px-2 bg-gray-50 text-gray-700 hover:bg-gray-100 disabled:bg-gray-25 disabled:text-gray-400"
                        >
                            <span className="group-hover:hidden inline-flex"><RedoIcon className="w-3.5 h-3.5" /></span>
                            <span className="hidden group-hover:inline">Redo</span>
                        </Button>
                    </div>}
                    
                    {/* View controls (hidden in live mode) */}
                    {!isLive && (<div className="flex items-center gap-2 mr-2">
                        {(() => {
                            // Current visibility booleans
                            const showAgents = viewMode !== "two_chat_skipper";
                            const showChat = viewMode !== "two_agents_skipper";
                            const showSkipper = viewMode !== "two_agents_chat";

                            // Determine selected radio option
                            type RadioKey = 'show-all' | 'hide-agents' | 'hide-chat' | 'hide-skipper';
                            let selectedKey: RadioKey = 'show-all';
                            if (!(showAgents && showChat && showSkipper)) {
                                if (!showAgents) selectedKey = 'hide-agents';
                                else if (!showChat) selectedKey = 'hide-chat';
                                else if (!showSkipper) selectedKey = 'hide-skipper';
                            }

                            // Map radio selection to viewMode
                            const setByKey = (key: RadioKey) => {
                                switch (key) {
                                    case 'show-all':
                                        onSetViewMode('three_all');
                                        break;
                                    case 'hide-agents':
                                        onSetViewMode('two_chat_skipper');
                                        break;
                                    case 'hide-chat':
                                        onSetViewMode('two_agents_skipper');
                                        break;
                                    case 'hide-skipper':
                                        onSetViewMode('two_agents_chat');
                                        break;
                                }
                            };

                            // Disable rules
                            // When there are zero agents, allow only Show All and Hide Chat
                            const zeroAgents = !hasAgents;
                            const disableShowAll = false; // always allow switching to 3-pane view
                            const disableHideAgents = zeroAgents; // cannot hide agents if none exist
                            const disableHideChat = false; // allow hide chat even with zero agents (default)
                            const disableHideSkipper = zeroAgents; // keep skipper visible when no agents

                            return (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" aria-label="Layout options" className="h-8 min-w-0 bg-transparent text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/50 border border-transparent gap-1 px-2">
                                    {/* 3-pane layout icon */}
                                    <svg width="26" height="18" viewBox="0 0 18 12" aria-hidden="true">
                                        <rect x="0.5" y="0.5" width="17" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.6" />
                                        <rect x="2" y="2" width="4" height="8" rx="0.5" fill="currentColor" opacity="0.8" />
                                        <rect x="7" y="2" width="4" height="8" rx="0.5" fill="currentColor" opacity="0.6" />
                                        <rect x="12" y="2" width="4" height="8" rx="0.5" fill="currentColor" opacity="0.4" />
                                    </svg>
                                    <ChevronDownIcon size={14} />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent aria-label="Choose layout">
                                <DropdownMenuRadioGroup value={selectedKey} onValueChange={(value) => {
                                    const key = value as RadioKey;
                                    const zeroAgents = !hasAgents;
                                    if (zeroAgents && key !== 'show-all' && key !== 'hide-chat') return;
                                    if (key === 'hide-chat' && disableHideChat) return;
                                    setByKey(key);
                                }}>
                                    <DropdownMenuRadioItem value="show-all" disabled={disableShowAll}>Show All</DropdownMenuRadioItem>
                                    <DropdownMenuRadioItem value="hide-agents" disabled={disableHideAgents}>Hide Agents</DropdownMenuRadioItem>
                                    <DropdownMenuRadioItem value="hide-chat" disabled={disableHideChat}>Hide Chat</DropdownMenuRadioItem>
                                    <DropdownMenuRadioItem value="hide-skipper" disabled={disableHideSkipper}>Hide Skipper</DropdownMenuRadioItem>
                                </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                        </DropdownMenu>
                            );
                        })()}
                    </div>)}

                    {/* Deploy CTA - conditional based on auto-publish mode */}
                    <div className="flex items-center gap-3">
                        {autoPublishEnabled ? (
                            <>
                                {/* Auto-publish mode: Show Use Assistant button */}
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            variant="default"
                                            size="sm"
                                            className="gap-2 px-3 h-8 bg-blue-50 hover:bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 dark:text-blue-400 font-semibold text-sm border border-blue-200 dark:border-blue-700 shadow-sm"
                                            onClick={onUseAssistantClick}
                                        >
                                            <Plug size={14} />
                                            Use Assistant
                                            <ChevronDownIcon size={12} />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent aria-label="Assistant access options">
                                        <DropdownMenuItem
                                            onClick={() => { 
                                                onUseAssistantClick();
                                                onStartNewChatAndFocus();
                                            }}
                                        >
                                            <MessageCircleIcon size={16} />
                                            Chat with Assistant
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onClick={() => { 
                                                onUseAssistantClick();
                                                if (projectId) { router.push(`/projects/${projectId}/config`); } 
                                            }}
                                        >
                                            <SettingsIcon size={16} />
                                            API & SDK Settings
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onClick={() => { 
                                                onUseAssistantClick();
                                                if (projectId) { router.push(`/projects/${projectId}/manage-triggers`); } 
                                            }}
                                        >
                                            <ZapIcon size={16} />
                                            Manage Triggers
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>

                                <div className="flex items-center gap-2 ml-2">
                                    {publishing && <Spinner size="sm" />}
                                    <div className="flex">
                                        <Button
                                            variant="default"
                                            size="sm"
                                            onClick={handleShareClick}
                                            className={`gap-2 px-3 h-8 font-semibold text-sm rounded-r-none border shadow-sm bg-indigo-100 hover:bg-indigo-200 text-indigo-800 border-indigo-300`}
                                        >
                                            <ShareIcon size={14} />
                                            Share
                                        </Button>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    variant="default"
                                                    size="sm"
                                                    className={`min-w-0 px-2 h-8 rounded-l-none border border-l-0 shadow-sm bg-indigo-100 hover:bg-indigo-200 text-indigo-800 border-indigo-300`}
                                                >
                                                    <ChevronDownIcon size={12} />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent aria-label="Share actions">
                                                <DropdownMenuItem
                                                    onClick={onDownloadJSON}
                                                >
                                                    <DownloadIcon size={16} />
                                                    Download JSON
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                </div>
                            </>
                        ) : (
                            // Manual publish mode: Show current publish/live logic
                            isLive ? (
                                <>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="default"
                                                size="sm"
                                                className="gap-2 px-3 h-8 bg-blue-50 hover:bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 dark:text-blue-400 font-semibold text-sm border border-blue-200 dark:border-blue-700 shadow-sm"
                                                onClick={onUseAssistantClick}
                                            >
                                                <Plug size={14} />
                                                Use Assistant
                                                <ChevronDownIcon size={12} />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent aria-label="Assistant access options">
                                            <DropdownMenuItem
                                                onClick={() => { 
                                                    onUseAssistantClick();
                                                    onStartNewChatAndFocus();
                                                }}
                                            >
                                                <MessageCircleIcon size={16} />
                                                Chat with Assistant
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => { 
                                                    onUseAssistantClick();
                                                    if (projectId) { router.push(`/projects/${projectId}/config`); } 
                                                }}
                                            >
                                                <SettingsIcon size={16} />
                                                API & SDK Settings
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => { 
                                                    onUseAssistantClick();
                                                    if (projectId) { router.push(`/projects/${projectId}/manage-triggers`); } 
                                                }}
                                            >
                                                <ZapIcon size={16} />
                                                Manage Triggers
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>

                                    <div className="flex items-center gap-2 ml-2">
                                        {publishing && <Spinner size="sm" />}
                                        <div className="flex">
                                            <Button
                                                variant="default"
                                                size="sm"
                                                onClick={handleShareClick}
                                                className={`gap-2 px-3 h-8 font-semibold text-sm rounded-r-none border shadow-sm bg-indigo-100 hover:bg-indigo-200 text-indigo-800 border-indigo-300`}
                                            >
                                                <ShareIcon size={14} />
                                                Share
                                            </Button>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button
                                                        variant="default"
                                                        size="sm"
                                                        className={`min-w-0 px-2 h-8 rounded-l-none border border-l-0 shadow-sm bg-indigo-100 hover:bg-indigo-200 text-indigo-800 border-indigo-300`}
                                                    >
                                                        <ChevronDownIcon size={12} />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent aria-label="Share actions">
                                                    <DropdownMenuItem
                                                        onClick={onDownloadJSON}
                                                    >
                                                        <DownloadIcon size={16} />
                                                        Download JSON
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </div>
                                    </div>
                                </>) : (
                                // Draft mode in manual publish: Show publish button
                                <>
                                    <div className="flex">
                                    {(!hasAgents) ? (
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <span className="inline-flex">
                                                    <Button
                                                        variant="default"
                                                        size="sm"
                                                        onClick={onPublishWorkflow}
                                                        disabled
                                                        className={`gap-2 px-3 h-8 font-semibold text-sm rounded-r-none border shadow-sm bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed min-w-[120px]`}
                                                        data-tour-target="deploy"
                                                    >
                                                        <RocketIcon size={14} />
                                                        Publish
                                                    </Button>
                                                </span>
                                            </TooltipTrigger>
                                            <TooltipContent>Create agents to publish your assistant</TooltipContent>
                                        </Tooltip>
                                    ) : (
                                        <Button
                                            variant="default"
                                            size="sm"
                                            onClick={onPublishWorkflow}
                                            className={`gap-2 px-3 h-8 font-semibold text-sm rounded-r-none border shadow-sm bg-green-100 hover:bg-green-200 text-green-800 border-green-300 min-w-[132px]`}
                                            data-tour-target="deploy"
                                        >
                                            <RocketIcon size={14} />
                                            Publish
                                        </Button>
                                    )}
                                    {hasAgents ? (
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    variant="default"
                                                    size="sm"
                                                    className={`min-w-0 px-2 h-8 rounded-l-none border border-l-0 shadow-sm bg-green-100 hover:bg-green-200 text-green-800 border-green-300`}
                                                >
                                                    <ChevronDownIcon size={12} />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent aria-label="Deploy actions">
                                                <DropdownMenuItem
                                                    onClick={() => onChangeMode('live')}
                                                >
                                                    <RadioIcon size={16} />
                                                    View live version
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    onClick={onRevertToLive}
                                                    className="text-red-600 dark:text-red-400"
                                                >
                                                    <AlertTriangle size={16} />
                                                    Reset to live version
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    ) : (
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <span className="inline-flex">
                                                    <Button
                                                        variant="default"
                                                        size="sm"
                                                        disabled
                                                        className={`min-w-0 px-2 h-8 rounded-l-none border border-l-0 shadow-sm bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed`}
                                                    >
                                                        <ChevronDownIcon size={12} />
                                                    </Button>
                                                </span>
                                            </TooltipTrigger>
                                            <TooltipContent>Create agents to publish your assistant</TooltipContent>
                                        </Tooltip>
                                    )}
                                    </div>

                                    <div className="flex items-center gap-2 ml-2">
                                        {publishing && <Spinner size="sm" />}
                                        <div className="flex">
                                            <Button
                                                variant="default"
                                                size="sm"
                                                onClick={handleShareClick}
                                                className={`gap-2 px-3 h-8 font-semibold text-sm rounded-r-none border shadow-sm bg-indigo-100 hover:bg-indigo-200 text-indigo-800 border-indigo-300`}
                                            >
                                                <ShareIcon size={14} />
                                                Share
                                            </Button>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button
                                                        variant="default"
                                                        size="sm"
                                                        className={`min-w-0 px-2 h-8 rounded-l-none border border-l-0 shadow-sm bg-indigo-100 hover:bg-indigo-200 text-indigo-800 border-indigo-300`}
                                                    >
                                                        <ChevronDownIcon size={12} />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent aria-label="Share actions">
                                                    <DropdownMenuItem
                                                        onClick={onDownloadJSON}
                                                    >
                                                        <DownloadIcon size={16} />
                                                        Download JSON
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </div>
                                    </div>
                                </>
                            )
                        )}
                    </div>

                </div>
            </div>
        </div>

        {/* Share Modal */}
        <Dialog
            open={isShareModalOpen}
            onOpenChange={(open) => { if (!open) onShareModalClose(); }}
        >
            <DialogContent
                className="sm:max-w-2xl max-h-[90vh] overflow-y-auto bg-white dark:bg-gray-900"
            >
                <DialogHeader className="border-b border-gray-200 dark:border-gray-700 pb-4">
                    <DialogTitle className="text-xl font-semibold text-gray-900 dark:text-gray-100">Share Assistant</DialogTitle>
                    <p className="text-sm text-gray-500 dark:text-gray-400 font-normal">Choose how you&apos;d like to share your assistant</p>
                </DialogHeader>
                <div className="space-y-8 py-2">
                    {/* Quick Share Section */}
                    <div className="space-y-4">
                        <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                                <ShareIcon size={16} className="text-blue-600 dark:text-blue-400" />
                            </div>
                            <div>
                                <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">Quick Share</h3>
                                <p className="text-sm text-gray-500 dark:text-gray-400">Share with a direct link</p>
                            </div>
                        </div>
                        
                        {shareUrl ? (
                            <div className="flex items-center gap-3 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-200 dark:border-gray-700">
                                <div className="flex-1 min-w-0">
                                    <input
                                        type="text"
                                        value={shareUrl || ''}
                                        readOnly
                                        className="w-full bg-transparent text-sm text-gray-700 dark:text-gray-300 outline-none font-mono focus:outline-none !focus:ring-0 !focus:ring-offset-0 !ring-0 !ring-offset-0"
                                    />
                                </div>
                                <Button
                                    size="sm"
                                    variant="default"
                                    onClick={handleCopyUrl}
                                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium"
                                >
                                    {copyButtonText}
                                </Button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-3 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-200 dark:border-gray-700">
                                <Spinner size="sm" />
                                <span className="text-sm text-gray-500 dark:text-gray-400">
                                    Generating share URL...
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Divider */}
                    {SHOW_COMMUNITY_PUBLISH && (
                        <div className="relative">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-gray-200 dark:border-gray-700"></div>
                            </div>
                            <div className="relative flex justify-center">
                                <span className="px-4 bg-white dark:bg-gray-900 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">or</span>
                            </div>
                        </div>
                    )}

                    {/* Community Publishing Section */}
                    {SHOW_COMMUNITY_PUBLISH && (
                        <div className="space-y-6">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                                    <MessageCircleIcon size={16} className="text-purple-600 dark:text-purple-400" />
                                </div>
                                <div>
                                    <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">Publish to Community</h3>
                                    <p className="text-sm text-gray-500 dark:text-gray-400">Make it discoverable by others</p>
                                </div>
                            </div>
                            
                            <div className="space-y-5">
                                {/* Assistant Name */}
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                                        Assistant Name <span className="text-red-500">*</span>
                                    </label>
                                    <Input
                                        placeholder="Enter assistant name"
                                        value={communityData.name}
                                        onChange={(e) => setCommunityData({ ...communityData, name: e.target.value })}
                                        className="text-sm border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500 focus-visible:border-gray-300 dark:focus-visible:border-gray-500 focus-visible:ring-0"
                                    />
                                </div>

                                {/* Description */}
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                                        Description <span className="text-red-500">*</span>
                                    </label>
                                    <Textarea
                                        placeholder="Describe what this assistant does..."
                                        value={communityData.description}
                                        onChange={(e) => setCommunityData({ ...communityData, description: e.target.value })}
                                        rows={3}
                                        className="text-sm border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500 focus-visible:border-gray-300 dark:focus-visible:border-gray-500 focus-visible:ring-0"
                                    />
                                </div>

                                {/* Category */}
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                                        Category <span className="text-red-500">*</span>
                                    </label>
                                    <Select
                                        value={communityData.category || undefined}
                                        onValueChange={(value) => {
                                            setCommunityData({ ...communityData, category: value });
                                        }}
                                    >
                                        <SelectTrigger className="w-full border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500 focus-visible:ring-0">
                                            <SelectValue placeholder="Select a category" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="Work Productivity">Work Productivity</SelectItem>
                                            <SelectItem value="Developer Productivity">Developer Productivity</SelectItem>
                                            <SelectItem value="News & Social">News & Social</SelectItem>
                                            <SelectItem value="Customer Support">Customer Support</SelectItem>
                                            <SelectItem value="Education">Education</SelectItem>
                                            <SelectItem value="Entertainment">Entertainment</SelectItem>
                                            <SelectItem value="Other">Other</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                {/* Privacy Toggle */}
                                <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800/30 rounded-xl border border-gray-200 dark:border-gray-700">
                                    <div className="flex-1">
                                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
                                            {communityData.isAnonymous ? 'Publish anonymously' : `Publish as ${getUserDisplayName()}`}
                                        </div>
                                        <div className="text-xs text-gray-500 dark:text-gray-400">
                                            {communityData.isAnonymous ? 'Your name will be hidden from the community' : 'Your name will be visible to the community'}
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setCommunityData({ ...communityData, isAnonymous: !communityData.isAnonymous })}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                                            communityData.isAnonymous ? 'bg-gray-300 dark:bg-gray-600' : 'bg-blue-600'
                                        }`}
                                    >
                                        <span
                                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                                communityData.isAnonymous ? 'translate-x-1' : 'translate-x-6'
                                            }`}
                                        />
                                    </button>
                                </div>

                                {/* Success Message */}
                                {communityPublishSuccess && (
                                    <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl">
                                        <div className="w-5 h-5 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
                                            <span className="text-green-600 dark:text-green-400 text-xs">✓</span>
                                        </div>
                                        <p className="text-green-700 dark:text-green-300 text-sm font-medium">
                                            Successfully published to community!
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
                <DialogFooter className="gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
                    <Button 
                        variant="ghost" 
                        onClick={onShareModalClose}
                        className="px-6 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                    >
                        Close
                    </Button>
                    {SHOW_COMMUNITY_PUBLISH && (
                        <Button
                            onClick={() => {
                                // Open confirmation first
                                setIsConfirmOpen(true);
                            }}
                            disabled={communityPublishing || communityPublishSuccess || !communityData.name.trim() || !communityData.description.trim() || !communityData.category}
                            className={`${communityPublishSuccess ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'} px-6 py-2 text-white font-medium`}
                        >
                            {communityPublishing && <Spinner size="sm" />}
                            {communityPublishSuccess ? 'Published' : (communityPublishing ? 'Publishing...' : 'Publish to Community')}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>

        {/* Confirmation Modal for Community Publish */}
        {SHOW_COMMUNITY_PUBLISH && (
            <Dialog
                open={isConfirmOpen}
                onOpenChange={(open) => { if (!open) { setAcknowledged(false); onConfirmClose(); } }}
            >
                <DialogContent
                    className="sm:max-w-md bg-white dark:bg-gray-900"
                >
                    <DialogHeader className="border-b border-gray-200 dark:border-gray-700 pb-3">
                        <DialogTitle className="text-lg font-semibold text-gray-900 dark:text-gray-100">Confirm publish to community</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300 py-2">
                        <p>Publishing to community will make this assistant and its description publicly visible to other users.</p>
                        <ul className="list-disc pl-5 space-y-1">
                            <li>Your assistant may appear in the community templates library.</li>
                            <li>Others can import and use this assistant in their own projects.</li>
                            <li>Do not include secrets or private data in the description or workflow.</li>
                        </ul>
                        <div className="mt-3 flex items-start gap-2">
                            <input
                                id="ack-publish"
                                type="checkbox"
                                checked={acknowledged}
                                onChange={(e) => setAcknowledged(e.target.checked)}
                                className="mt-1 h-4 w-4"
                            />
                            <label htmlFor="ack-publish" className="text-sm">I understand this will be publicly available.</label>
                        </div>
                    </div>
                    <DialogFooter className="border-t border-gray-200 dark:border-gray-700 pt-3">
                        <Button variant="ghost" onClick={() => { setAcknowledged(false); onConfirmClose(); }}>Cancel</Button>
                        <Button
                            disabled={!acknowledged}
                            onClick={() => {
                                onConfirmClose();
                                setAcknowledged(false);
                                onCommunityPublish();
                            }}
                        >
                            Confirm & Publish
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        )}
        </>
    );
}
