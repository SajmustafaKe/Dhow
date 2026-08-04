"use client"

import * as React from "react"
import { GripVertical } from "lucide-react"
import * as ResizablePrimitive from "react-resizable-panels"

import clsx from 'clsx';

// dhow's package.json pins react-resizable-panels@2.1.7; dhowx has 4.12.2
// installed. v4 renamed PanelGroup/PanelResizeHandle to Group/Separator,
// replaced `direction` with `orientation`, dropped the
// `data-panel-group-direction` attribute the shadcn styles below key off of,
// and reinterprets bare-number defaultSize/minSize/maxSize as pixels instead
// of percentages. This wrapper restores the old surface (direction prop,
// percentage-based sizes, the data attribute) on top of the v4 primitives so
// existing callers (e.g. workflow_editor.tsx, entity_list.tsx) don't need to
// change when they're ported.
type Direction = "horizontal" | "vertical";

const DirectionContext = React.createContext<Direction>("horizontal");

function toPercentSize(size: number | string | undefined): number | string | undefined {
  return typeof size === "number" ? `${size}%` : size;
}

interface ResizablePanelGroupProps
  extends Omit<React.ComponentProps<typeof ResizablePrimitive.Group>, "orientation"> {
  direction?: Direction;
}

const ResizablePanelGroup = ({
  className,
  direction = "horizontal",
  ...props
}: ResizablePanelGroupProps) => (
  <DirectionContext.Provider value={direction}>
    <ResizablePrimitive.Group
      orientation={direction}
      className={clsx(
        "flex h-full w-full data-[direction=vertical]:flex-col",
        className
      )}
      data-direction={direction}
      {...props}
    />
  </DirectionContext.Provider>
)

interface ResizablePanelProps
  extends Omit<React.ComponentProps<typeof ResizablePrimitive.Panel>, "defaultSize" | "minSize" | "maxSize"> {
  defaultSize?: number | string;
  minSize?: number | string;
  maxSize?: number | string;
  order?: number;
}

const ResizablePanel = ({ defaultSize, minSize, maxSize, order, style, ...props }: ResizablePanelProps) => (
  <ResizablePrimitive.Panel
    defaultSize={toPercentSize(defaultSize)}
    minSize={toPercentSize(minSize)}
    maxSize={toPercentSize(maxSize)}
    style={order !== undefined ? { ...style, order } : style}
    {...props}
  />
)

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
  withHandle?: boolean
}) => {
  const direction = React.useContext(DirectionContext);
  return (
    <ResizablePrimitive.Separator
      data-direction={direction}
      className={clsx(
        "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 data-[direction=vertical]:h-px data-[direction=vertical]:w-full data-[direction=vertical]:after:left-0 data-[direction=vertical]:after:h-1 data-[direction=vertical]:after:w-full data-[direction=vertical]:after:-translate-y-1/2 data-[direction=vertical]:after:translate-x-0 [&[data-direction=vertical]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
          <GripVertical className="h-2.5 w-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
