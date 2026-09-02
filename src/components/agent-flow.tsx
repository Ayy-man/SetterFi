"use client";

import { Check, ShieldAlert, X } from "@/components/kit/icons";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Handle,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useReducedMotion } from "motion/react";

import type { AgentStage, Booking, GuardrailEvent } from "@/lib/agent-simulator";

type TraceStatus = "idle" | "active" | "done" | "deflect" | "block";
type TraceId = AgentStage | "brain";

type TraceNodeData = {
  label: string;
  sublabel: string;
  status: TraceStatus;
};

type TraceEdgeData = {
  status: TraceStatus;
  animate: boolean;
};

type TraceNode = Node<TraceNodeData, "trace">;
type TraceEdge = Edge<TraceEdgeData, "trace">;

export type AgentFlowProps = {
  sessionId: string | null;
  current: AgentStage;
  done: AgentStage[];
  thinking: boolean;
  brainUsed: boolean;
  guardrail: GuardrailEvent | null;
  booked: Booking | null;
  decisionLabel: string;
};

/* Top-to-bottom graph on a three-column grid. The spine (greeting to qualify to
   book) runs straight down the middle column, the brain feeds qualify from the
   left, and the two branch paths (objection, guardrail) sit either side so no
   edge ever crosses a node. Bounds are ~504 × 456, close enough to square that
   fitView keeps node labels legible in a narrow panel. */
const NODE_LAYOUT: Record<TraceId, { x: number; y: number }> = {
  greeting: { x: 180, y: 0 },
  brain: { x: 0, y: 130 },
  qualify: { x: 180, y: 130 },
  objection: { x: 0, y: 265 },
  guardrail: { x: 360, y: 265 },
  book: { x: 180, y: 400 },
  closing: { x: 360, y: 400 },
};

const TRACE_IDS = Object.keys(NODE_LAYOUT) as TraceId[];

const EDGE_LAYOUT: ReadonlyArray<{
  source: TraceId;
  target: TraceId;
  sourceHandle: "bottom" | "right";
  targetHandle: "top" | "left";
}> = [
  { source: "greeting", target: "qualify", sourceHandle: "bottom", targetHandle: "top" },
  { source: "brain", target: "qualify", sourceHandle: "right", targetHandle: "left" },
  { source: "qualify", target: "objection", sourceHandle: "bottom", targetHandle: "top" },
  { source: "qualify", target: "book", sourceHandle: "bottom", targetHandle: "top" },
  { source: "qualify", target: "guardrail", sourceHandle: "bottom", targetHandle: "top" },
  { source: "objection", target: "book", sourceHandle: "bottom", targetHandle: "top" },
  { source: "guardrail", target: "closing", sourceHandle: "bottom", targetHandle: "top" },
];

const NODE_LABELS: Record<TraceId, string> = {
  brain: "The Brain",
  greeting: "Greeting",
  qualify: "Qualify",
  objection: "Objection",
  guardrail: "Guardrail",
  book: "Book call",
  closing: "Closing",
};

/* The nodes the trace walks while a turn is in flight, so the canvas shows the
   agent reading before it shows the agent answering. */
const SCAN_SEQUENCE: TraceId[] = ["greeting", "brain", "qualify"];
const SCAN_STEP_MS = 260;

const FIT_VIEW_OPTIONS = { padding: 0.16, minZoom: 0.4, maxZoom: 1.15 } as const;

function TraceNodeComponent({ data }: NodeProps<TraceNode>) {
  const icon = data.status === "done"
    ? <Check aria-hidden="true" />
    : data.status === "block"
      ? <X aria-hidden="true" />
      : data.status === "deflect"
        ? <ShieldAlert aria-hidden="true" />
        : null;

  return (
    <div className="trace-node" data-status={data.status}>
      <Handle className="trace-handle" id="top" type="target" position={Position.Top} />
      <Handle className="trace-handle" id="left" type="target" position={Position.Left} />
      <div className="trace-node__heading">
        <span className="trace-node__mark">{icon}</span>
        <span>{data.label}</span>
      </div>
      <div className="trace-node__sub mono">{data.sublabel}</div>
      <Handle className="trace-handle" id="bottom" type="source" position={Position.Bottom} />
      <Handle className="trace-handle" id="right" type="source" position={Position.Right} />
    </div>
  );
}

function TraceEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
}: EdgeProps<TraceEdge>) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 14,
  });

  const status = data?.status ?? "idle";
  const live = data?.animate === true
    && (status === "active" || status === "deflect" || status === "block");

  return (
    <>
      <BaseEdge id={id} path={path} style={style} />
      {live ? (
        <circle
          className="trace-edge-pulse"
          cx={(sourceX + targetX) / 2}
          cy={(sourceY + targetY) / 2}
          data-tone={status}
          r={4}
        />
      ) : null}
    </>
  );
}

const nodeTypes = { trace: memo(TraceNodeComponent) };
const edgeTypes = { trace: memo(TraceEdgeComponent) };

type TraceState = AgentFlowProps & { scanStage: TraceId | null };

function nodeStatus(id: TraceId, state: TraceState): TraceStatus {
  if (!state.sessionId) return "idle";

  if (state.thinking) {
    if (id === state.scanStage) return "active";
    if (id === "brain") return state.brainUsed ? "done" : "idle";
    return state.done.includes(id) ? "done" : "idle";
  }

  if (id === "brain") return state.brainUsed ? "done" : "idle";

  if (id === "guardrail" && state.guardrail) {
    return state.guardrail.type === "block" ? "block" : "deflect";
  }

  if (id === state.current) return "active";
  if (state.done.includes(id)) return "done";
  return "idle";
}

function edgeStatus(source: TraceId, target: TraceId, state: TraceState): TraceStatus {
  if (!state.sessionId) return "idle";

  if (!state.thinking && target === "guardrail" && state.guardrail) {
    return state.guardrail.type === "block" ? "block" : "deflect";
  }

  const activeNode = state.thinking ? state.scanStage : state.current;
  if (target === activeNode) return "active";

  const sourceDone = source === "brain" ? state.brainUsed : state.done.includes(source);
  const targetDone = target !== "brain" && state.done.includes(target);
  return sourceDone && targetDone ? "done" : "idle";
}

const EDGE_COLOR: Record<TraceStatus, string> = {
  block: "var(--critical)",
  deflect: "var(--warning)",
  active: "var(--good)",
  done: "var(--good)",
  idle: "var(--line-strong)",
};

export type AgentFlowSnapshotNode = {
  id: TraceId;
  label: string;
  sublabel: string;
  status: TraceStatus;
};

export function agentFlowSnapshot(
  props: AgentFlowProps,
  scanStage: TraceId | null = null,
): AgentFlowSnapshotNode[] {
  const state: TraceState = { ...props, scanStage };
  const sessionReady = Boolean(state.sessionId);
  const sublabels: Record<TraceId, string> = {
    brain: sessionReady ? (state.brainUsed ? "grounded retrieval" : "retrieval") : "waiting for session",
    greeting: sessionReady ? "configured opener" : "waiting for session",
    qualify: sessionReady ? state.decisionLabel.toLowerCase() : "waiting for session",
    objection: sessionReady ? "The Brain reframes" : "waiting for session",
    book: sessionReady ? state.booked?.slot ?? "test calendar" : "waiting for session",
    guardrail: sessionReady ? state.guardrail?.rule ?? "policy" : "waiting for session",
    closing: sessionReady
      ? state.current === "closing" ? "test run complete" : "exit path"
      : "waiting for session",
  };

  return TRACE_IDS.map((id) => ({
    id,
    label: NODE_LABELS[id],
    sublabel: sublabels[id],
    status: nodeStatus(id, state),
  }));
}

export function AgentFlow(props: AgentFlowProps) {
  const reducedMotion = useReducedMotion();
  const [scanStep, setScanStep] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ReactFlowInstance<TraceNode, TraceEdge> | null>(null);

  const { thinking } = props;

  // While a turn is in flight the trace walks greeting to brain to qualify, so the
  // canvas shows the agent reading before it shows the agent answering. The
  // first timer also rewinds the sequence for the next turn.
  useEffect(() => {
    if (!thinking || reducedMotion) return;

    const timers = SCAN_SEQUENCE.map((_, step) =>
      window.setTimeout(() => setScanStep(step), step * SCAN_STEP_MS));

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [thinking, reducedMotion]);

  const scanStage: TraceId | null = !thinking
    ? null
    : reducedMotion
      ? "brain"
      : SCAN_SEQUENCE[Math.min(scanStep, SCAN_SEQUENCE.length - 1)];

  // Panning is off, so the graph has to re-centre itself whenever the panel
  // resizes, including viewport changes or the mobile tab switching it back into view.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      instanceRef.current?.fitView(FIT_VIEW_OPTIONS);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const state = useMemo<TraceState>(() => ({ ...props, scanStage }), [props, scanStage]);

  const nodes = useMemo<TraceNode[]>(() => {
    return agentFlowSnapshot(props, scanStage).map((snapshot) => ({
      id: snapshot.id,
      type: "trace" as const,
      position: NODE_LAYOUT[snapshot.id],
      draggable: false,
      selectable: false,
      data: {
        label: snapshot.label,
        sublabel: snapshot.sublabel,
        status: snapshot.status,
      },
      ariaLabel: `${snapshot.label}: ${snapshot.status}`,
    }));
  }, [props, scanStage]);

  const edges = useMemo<TraceEdge[]>(() => EDGE_LAYOUT.map((edge) => {
    const status = edgeStatus(edge.source, edge.target, state);
    const emphasised = status === "active" || status === "block" || status === "deflect";

    return {
      id: `${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type: "trace" as const,
      className: `trace-edge trace-edge--${status}`,
      data: { status, animate: emphasised && !reducedMotion },
      style: {
        stroke: EDGE_COLOR[status],
        strokeWidth: 2,
        opacity: status === "idle" ? 0.72 : status === "done" ? 0.78 : 1,
      },
    };
  }), [state, reducedMotion]);

  return (
    <div
      className="flow-canvas"
      data-session-state={props.sessionId ? "ready" : "idle"}
      ref={shellRef}
      role="group"
      aria-label="Agent decision flow trace"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(instance) => {
          instanceRef.current = instance;
          instance.fitView(FIT_VIEW_OPTIONS);
        }}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={FIT_VIEW_OPTIONS.minZoom}
        maxZoom={FIT_VIEW_OPTIONS.maxZoom}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          color="var(--info-line)"
          gap={15}
          size={1}
          variant={BackgroundVariant.Dots}
        />
      </ReactFlow>
      {!props.sessionId ? (
        <div
          className="trace-idle pointer-events-none absolute inset-0 z-10 grid place-items-center p-6 text-center"
          role="status"
        >
          <div className="max-w-sm rounded-lg border border-border bg-card/95 px-6 py-4 shadow-[var(--shadow-card)]">
            <strong className="block text-body font-semibold text-foreground">
              No test session is running
            </strong>
            <span className="mt-1 block text-body text-muted-foreground">
              The flow stays idle until the server confirms a secure test session.
            </span>
          </div>
        </div>
      ) : null}
      <ol className="sr-only">
        {nodes.map((node) => (
          <li key={node.id}>
            {node.data.label}: {node.data.status}. {node.data.sublabel}.
          </li>
        ))}
      </ol>
    </div>
  );
}
