/**
 * Graph ingestion: validate a JSON document and compile it into the flat,
 * index-addressed {@link Graph} the simulation consumes.
 *
 * Validation is strict on purpose. A graph file is untrusted input — it may be
 * dropped onto the page by a user or fetched from a URL — and a malformed one
 * must fail loudly at load time rather than producing NaN positions three
 * thousand frames later.
 */

import type { Graph, GraphInput, GraphNodeInput, GraphEdgeInput } from './types.js';

export class GraphValidationError extends Error {
  constructor(
    message: string,
    /** Dotted path to the offending value, e.g. `nodes[3].id`. */
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'GraphValidationError';
  }
}

/** Upper bounds. Beyond these the layout stops being interactive in a headset. */
export const MAX_NODES = 20_000;
export const MAX_EDGES = 80_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new GraphValidationError(`expected a string, got ${typeof raw}`, `${path}.${key}`);
  }
  return raw;
}

function readOptionalWeight(
  source: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new GraphValidationError('expected a finite number', `${path}.${key}`);
  }
  if (raw < 0) {
    throw new GraphValidationError('must not be negative', `${path}.${key}`);
  }
  return raw;
}

/**
 * Parse an unknown value (typically `JSON.parse` output) into a {@link GraphInput}.
 * Throws {@link GraphValidationError} with a precise path on the first problem.
 */
export function parseGraphInput(value: unknown): GraphInput {
  if (!isRecord(value)) {
    throw new GraphValidationError('expected a JSON object at the document root', '$');
  }

  const rawNodes = value['nodes'];
  if (!Array.isArray(rawNodes)) {
    throw new GraphValidationError('expected an array', 'nodes');
  }
  if (rawNodes.length === 0) {
    throw new GraphValidationError('graph must contain at least one node', 'nodes');
  }
  if (rawNodes.length > MAX_NODES) {
    throw new GraphValidationError(`at most ${MAX_NODES} nodes are supported`, 'nodes');
  }

  const rawEdges = value['edges'] ?? [];
  if (!Array.isArray(rawEdges)) {
    throw new GraphValidationError('expected an array', 'edges');
  }
  if (rawEdges.length > MAX_EDGES) {
    throw new GraphValidationError(`at most ${MAX_EDGES} edges are supported`, 'edges');
  }

  const nodes: GraphNodeInput[] = rawNodes.map((entry, index) => {
    const path = `nodes[${index}]`;
    if (!isRecord(entry)) {
      throw new GraphValidationError('expected an object', path);
    }
    const id = entry['id'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new GraphValidationError('expected a non-empty string', `${path}.id`);
    }
    const node: GraphNodeInput = { id };
    const label = readOptionalString(entry, 'label', path);
    if (label !== undefined) node.label = label;
    const group = readOptionalString(entry, 'group', path);
    if (group !== undefined) node.group = group;
    const weight = readOptionalWeight(entry, 'weight', path);
    if (weight !== undefined) node.weight = weight;
    return node;
  });

  const edges: GraphEdgeInput[] = rawEdges.map((entry, index) => {
    const path = `edges[${index}]`;
    if (!isRecord(entry)) {
      throw new GraphValidationError('expected an object', path);
    }
    const source = entry['source'];
    const target = entry['target'];
    if (typeof source !== 'string' || source.length === 0) {
      throw new GraphValidationError('expected a non-empty string', `${path}.source`);
    }
    if (typeof target !== 'string' || target.length === 0) {
      throw new GraphValidationError('expected a non-empty string', `${path}.target`);
    }
    const edge: GraphEdgeInput = { source, target };
    const weight = readOptionalWeight(entry, 'weight', path);
    if (weight !== undefined) edge.weight = weight;
    return edge;
  });

  const name = readOptionalString(value, 'name', '$');
  return name !== undefined ? { name, nodes, edges } : { nodes, edges };
}

/**
 * Compile a validated {@link GraphInput} into typed arrays.
 *
 * Self-loops and duplicate edges are dropped: neither contributes anything to a
 * force-directed layout, and both cost a spring evaluation every step.
 */
export function compileGraph(input: GraphInput): Graph {
  const nodeCount = input.nodes.length;
  const index = new Map<string, number>();
  const ids: string[] = new Array<string>(nodeCount);
  const labels: string[] = new Array<string>(nodeCount);
  const groupNames: string[] = [];
  const groupIndex = new Map<string, number>();
  const groupOf = new Uint16Array(nodeCount);

  for (let i = 0; i < nodeCount; i++) {
    const node = input.nodes[i]!;
    if (index.has(node.id)) {
      throw new GraphValidationError(
        `duplicate node id ${JSON.stringify(node.id)}`,
        `nodes[${i}].id`,
      );
    }
    index.set(node.id, i);
    ids[i] = node.id;
    labels[i] = node.label ?? node.id;
    const group = node.group ?? 'default';
    let gid = groupIndex.get(group);
    if (gid === undefined) {
      gid = groupNames.length;
      if (gid > 0xffff) {
        throw new GraphValidationError('too many distinct groups (max 65536)', `nodes[${i}].group`);
      }
      groupIndex.set(group, gid);
      groupNames.push(group);
    }
    groupOf[i] = gid;
  }

  const sources: number[] = [];
  const targets: number[] = [];
  const edgeWeightList: number[] = [];
  const seen = new Set<number>();
  const degrees = new Uint32Array(nodeCount);

  for (let i = 0; i < input.edges.length; i++) {
    const edge = input.edges[i]!;
    const s = index.get(edge.source);
    const t = index.get(edge.target);
    if (s === undefined) {
      throw new GraphValidationError(
        `references unknown node ${JSON.stringify(edge.source)}`,
        `edges[${i}].source`,
      );
    }
    if (t === undefined) {
      throw new GraphValidationError(
        `references unknown node ${JSON.stringify(edge.target)}`,
        `edges[${i}].target`,
      );
    }
    if (s === t) continue; // self-loop: no layout contribution
    const lo = Math.min(s, t);
    const hi = Math.max(s, t);
    const key = lo * nodeCount + hi;
    if (seen.has(key)) continue; // duplicate/antiparallel edge
    seen.add(key);
    sources.push(s);
    targets.push(t);
    edgeWeightList.push(edge.weight ?? 1);
    degrees[s]! += 1;
    degrees[t]! += 1;
  }

  const edgeCount = sources.length;
  const edges = new Uint32Array(edgeCount * 2);
  for (let e = 0; e < edgeCount; e++) {
    edges[e * 2] = sources[e]!;
    edges[e * 2 + 1] = targets[e]!;
  }

  // Render weight: explicit hint if given, otherwise a compressed degree curve.
  // sqrt keeps hubs visually dominant without letting one node swallow the scene.
  let maxDegree = 1;
  for (let i = 0; i < nodeCount; i++) maxDegree = Math.max(maxDegree, degrees[i]!);
  const weights = new Float32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const explicit = input.nodes[i]!.weight;
    weights[i] =
      explicit !== undefined ? Math.min(1, explicit) : Math.sqrt(degrees[i]! / maxDegree);
  }

  return {
    name: input.name ?? 'graph',
    ids,
    labels,
    groupNames,
    groupOf,
    weights,
    edges,
    edgeWeights: Float32Array.from(edgeWeightList),
    degrees,
    nodeCount,
    edgeCount,
  };
}

/** Convenience: validate and compile in one step. */
export function loadGraph(value: unknown): Graph {
  return compileGraph(parseGraphInput(value));
}

/**
 * Build a CSR-style adjacency index (offsets + flattened neighbours).
 *
 * Used by highlight-on-select. Kept separate from {@link Graph} because the
 * layout itself never needs it.
 */
export function buildAdjacency(graph: Graph): { offsets: Uint32Array; neighbours: Uint32Array } {
  const { nodeCount, edgeCount, edges, degrees } = graph;
  const offsets = new Uint32Array(nodeCount + 1);
  let running = 0;
  for (let i = 0; i < nodeCount; i++) {
    offsets[i] = running;
    running += degrees[i]!;
  }
  offsets[nodeCount] = running;

  const cursor = Uint32Array.from(offsets.subarray(0, nodeCount));
  const neighbours = new Uint32Array(running);
  for (let e = 0; e < edgeCount; e++) {
    const s = edges[e * 2]!;
    const t = edges[e * 2 + 1]!;
    neighbours[cursor[s]!++] = t;
    neighbours[cursor[t]!++] = s;
  }
  return { offsets, neighbours };
}

/**
 * Label every node with its connected-component id, via iterative BFS.
 *
 * Iterative rather than recursive: a 20k-node path graph would blow the stack.
 * Components are numbered in ascending order of their lowest member index, so
 * the numbering is stable across runs.
 */
export function connectedComponents(graph: Graph): { componentOf: Uint32Array; count: number } {
  const { offsets, neighbours } = buildAdjacency(graph);
  const componentOf = new Uint32Array(graph.nodeCount).fill(0xffffffff);
  const queue = new Uint32Array(graph.nodeCount);
  let count = 0;

  for (let seed = 0; seed < graph.nodeCount; seed++) {
    if (componentOf[seed] !== 0xffffffff) continue;
    const component = count++;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    componentOf[seed] = component;
    while (head < tail) {
      const node = queue[head++]!;
      const end = offsets[node + 1]!;
      for (let k = offsets[node]!; k < end; k++) {
        const next = neighbours[k]!;
        if (componentOf[next] === 0xffffffff) {
          componentOf[next] = component;
          queue[tail++] = next;
        }
      }
    }
  }
  return { componentOf, count };
}
