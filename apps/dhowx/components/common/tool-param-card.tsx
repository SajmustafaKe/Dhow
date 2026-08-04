"use client";
import React, { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { InputField } from "@/app/lib/components/input-field";

const PARAM_TYPES = ['string', 'number', 'boolean', 'array', 'object'] as const;

export function ToolParamCard({
  param,
  handleUpdate,
  handleDelete,
  handleRename,
  readOnly
}: {
  param: {
    name: string,
    description: string,
    type: string,
    required: boolean
  },
  handleUpdate: (name: string, data: {
    description: string,
    type: string,
    required: boolean
  }) => void,
  handleDelete: (name: string) => void,
  handleRename: (oldName: string, newName: string) => void,
  readOnly?: boolean
}) {
  const [expanded, setExpanded] = useState(false);
  const [localName, setLocalName] = useState(param.name);

  useEffect(() => {
    setLocalName(param.name);
  }, [param.name]);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-gray-900 mb-1">
      <button
        type="button"
        className="flex items-center gap-2 w-full px-4 py-2 focus:outline-none select-none"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
        <span className="text-sm font-normal text-gray-900 dark:text-gray-100 flex-1 text-left truncate">{param.name}</span>
        {!readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={e => { e.stopPropagation(); handleDelete(param.name); }}
            className="ml-2"
          >
            <Trash2 className="w-4 h-4" />
            Remove
          </Button>
        )}
      </button>
      <div
        style={{
          maxHeight: expanded ? 9999 : 0,
          overflow: "hidden",
          transition: "max-height 0.2s cubic-bezier(0.4,0,0.2,1)"
        }}
      >
        {expanded && (
          <div className="flex flex-col gap-4 px-4 pb-4 pt-2">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col md:flex-row md:items-start gap-1 md:gap-0">
                <label className="text-sm font-semibold text-gray-600 dark:text-gray-300 md:w-32 mb-1 md:mb-0 md:pr-4">Name</label>
                <div className="flex-1">
                  <InputField type="text"
                    value={localName}
                    onChange={(value: string) => {
                      setLocalName(value);
                      if (value && value !== param.name) {
                        handleRename(param.name, value);
                      }
                    }}
                    multiline={false}

                    className="w-full"
                    locked={readOnly}
                  />
                </div>
              </div>
              <div className="flex flex-col md:flex-row md:items-start gap-1 md:gap-0">
                <label className="text-sm font-semibold text-gray-600 dark:text-gray-300 md:w-32 mb-1 md:mb-0 md:pr-4">Description</label>
                <div className="flex-1">
                  <InputField
                    type="text"
                    value={param.description}
                    onChange={(value: string) => handleUpdate(param.name, {
                      ...param,
                      description: value
                    })}
                    multiline={true}
                    placeholder="Describe this parameter..."
                    className="w-full"
                    locked={readOnly}
                  />
                </div>
              </div>
              <div className="flex flex-col md:flex-row md:items-start gap-1 md:gap-0">
                <label className="text-sm font-semibold text-gray-600 dark:text-gray-300 md:w-32 mb-1 md:mb-0 md:pr-4">Type</label>
                <div className="flex-1">
                  <Select
                    value={param.type}
                    onValueChange={(value) => {
                      handleUpdate(param.name, {
                        ...param,
                        type: value
                      });
                    }}
                    disabled={readOnly}
                  >
                    <SelectTrigger size="sm" className="w-52">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PARAM_TYPES.map(type => (
                        <SelectItem key={type} value={type}>{type}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <label className="flex items-center gap-2 mt-2">
              <Checkbox
                checked={param.required}
                onCheckedChange={() => handleUpdate(param.name, {
                  ...param,
                  required: !param.required
                })}
                disabled={readOnly}
              />
              <span className="text-xs text-gray-500 dark:text-gray-400">Required parameter</span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
