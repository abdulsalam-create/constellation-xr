import { describe, expect, it } from 'vitest';
import {
  GraphValidationError,
  buildAdjacency,
  compileGraph,
  connectedComponents,
  loadGraph,
  parseGraphInput,
  MAX_NODES,
} from '../src/core/graph.js';

const minimal = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] };

describe('parseGraphInput', () => {
  it('accepts a minimal well-formed document', () => {
    const parsed = parseGraphInput(minimal);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges).toHaveLength(1);
  });

  it('defaults edges to an empty list when omitted', () => {
    const parsed = parseGraphInput({ nodes: [{ id: 'solo' }] });
    expect(parsed.edges).toEqual([]);
  });

  it.each([null, 'a string', [], 42, true])('rejects a non-object root (%s)', (value) => {
    expect(() => parseGraphInput(value)).toThrow(GraphValidationError);
  });

  it('rejects a missing nodes array', () => {
    expect(() => parseGraphInput({ edges: [] })).toThrow(/^nodes:/);
  });

  it('rejects an empty node list', () => {
    expect(() => parseGraphInput({ nodes: [] })).toThrow(/at least one node/);
  });

  it('rejects a node without an id', () => {
    expect(() => parseGraphInput({ nodes: [{ label: 'x' }] })).toThrow(/^nodes\[0\]\.id:/);
  });

  it('rejects an empty string id', () => {
    expect(() => parseGraphInput({ nodes: [{ id: '' }] })).toThrow(/^nodes\[0\]\.id:/);
  });

  it('reports the index of the offending node', () => {
    const doc = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 7 }] };
    expect(() => parseGraphInput(doc)).toThrow(/^nodes\[2\]\.id:/);
  });

  it('rejects a non-string label with a precise path', () => {
    const doc = { nodes: [{ id: 'a', label: 12 }] };
    expect(() => parseGraphInput(doc)).toThrow(/^nodes\[0\]\.label: expected a string/);
  });

  it('rejects a negative weight', () => {
    const doc = { nodes: [{ id: 'a', weight: -1 }] };
    expect(() => parseGraphInput(doc)).toThrow(/must not be negative/);
  });

  it('rejects a NaN weight', () => {
    const doc = { nodes: [{ id: 'a', weight: Number.NaN }] };
    expect(() => parseGraphInput(doc)).toThrow(/finite number/);
  });

  it('rejects an edge missing a source', () => {
    const doc = { nodes: [{ id: 'a' }], edges: [{ target: 'a' }] };
    expect(() => parseGraphInput(doc)).toThrow(/^edges\[0\]\.source:/);
  });

  it('rejects a node list beyond the supported maximum', () => {
    const nodes = { length: MAX_NODES + 1 };
    const doc = { nodes: Array.from(nodes, (_, i) => ({ id: `n${i}` })) };
    expect(() => parseGraphInput(doc)).toThrow(/at most/);
  });

  it('carries the path on the thrown error object', () => {
    try {
      parseGraphInput({ nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 5 }] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(GraphValidationError);
      expect((error as GraphValidationError).path).toBe('edges[0].target');
    }
  });
});

describe('compileGraph', () => {
  it('assigns dense indices in input order', () => {
    const graph = compileGraph(parseGraphInput(minimal));
    expect(graph.ids).toEqual(['a', 'b']);
    expect(graph.nodeCount).toBe(2);
    expect(graph.edgeCount).toBe(1);
    expect(Array.from(graph.edges)).toEqual([0, 1]);
  });

  it('falls back to the id when no label is given', () => {
    const graph = compileGraph(parseGraphInput({ nodes: [{ id: 'abc' }], edges: [] }));
    expect(graph.labels[0]).toBe('abc');
  });

  it('rejects duplicate node ids', () => {
    const doc = { nodes: [{ id: 'a' }, { id: 'a' }], edges: [] };
    expect(() => compileGraph(parseGraphInput(doc))).toThrow(/duplicate node id/);
  });

  it('rejects an edge referencing an unknown node', () => {
    const doc = { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'ghost' }] };
    expect(() => compileGraph(parseGraphInput(doc))).toThrow(/unknown node "ghost"/);
  });

  it('drops self-loops', () => {
    const doc = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'a' }] };
    const graph = compileGraph(parseGraphInput(doc));
    expect(graph.edgeCount).toBe(0);
    expect(graph.degrees[0]).toBe(0);
  });

  it('collapses duplicate and antiparallel edges', () => {
    const doc = {
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    };
    const graph = compileGraph(parseGraphInput(doc));
    expect(graph.edgeCount).toBe(1);
    expect(graph.degrees[0]).toBe(1);
    expect(graph.degrees[1]).toBe(1);
  });

  it('counts degree across both endpoints', () => {
    const doc = {
      nodes: [{ id: 'hub' }, { id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [
        { source: 'hub', target: 'a' },
        { source: 'hub', target: 'b' },
        { source: 'hub', target: 'c' },
      ],
    };
    const graph = compileGraph(parseGraphInput(doc));
    expect(graph.degrees[0]).toBe(3);
    expect(graph.degrees[1]).toBe(1);
  });

  it('interns groups in first-seen order', () => {
    const doc = {
      nodes: [
        { id: 'a', group: 'beta' },
        { id: 'b', group: 'alpha' },
        { id: 'c', group: 'beta' },
      ],
      edges: [],
    };
    const graph = compileGraph(parseGraphInput(doc));
    expect(graph.groupNames).toEqual(['beta', 'alpha']);
    expect(Array.from(graph.groupOf)).toEqual([0, 1, 0]);
  });

  it('places ungrouped nodes in a default group', () => {
    const graph = compileGraph(parseGraphInput(minimal));
    expect(graph.groupNames).toEqual(['default']);
  });

  it('derives render weight from degree when no hint is given', () => {
    const doc = {
      nodes: [{ id: 'hub' }, { id: 'leaf' }, { id: 'other' }],
      edges: [
        { source: 'hub', target: 'leaf' },
        { source: 'hub', target: 'other' },
      ],
    };
    const graph = compileGraph(parseGraphInput(doc));
    expect(graph.weights[0]).toBeCloseTo(1, 5);
    expect(graph.weights[1]).toBeLessThan(graph.weights[0]!);
    expect(graph.weights[1]).toBeGreaterThan(0);
  });

  it('honours and clamps an explicit weight hint', () => {
    const doc = { nodes: [{ id: 'a', weight: 5 }], edges: [] };
    const graph = compileGraph(parseGraphInput(doc));
    expect(graph.weights[0]).toBe(1);
  });

  it('survives a graph with no edges at all', () => {
    const graph = loadGraph({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [] });
    expect(graph.edgeCount).toBe(0);
    expect(graph.edges).toHaveLength(0);
  });
});

describe('buildAdjacency', () => {
  it('produces symmetric neighbour lists', () => {
    const graph = loadGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    });
    const { offsets, neighbours } = buildAdjacency(graph);
    const neighboursOf = (i: number): number[] =>
      Array.from(neighbours.subarray(offsets[i], offsets[i + 1])).sort();

    expect(neighboursOf(0)).toEqual([1]);
    expect(neighboursOf(1)).toEqual([0, 2]);
    expect(neighboursOf(2)).toEqual([1]);
  });

  it('writes one offset per node plus a terminator', () => {
    const graph = loadGraph(minimal);
    const { offsets } = buildAdjacency(graph);
    expect(offsets).toHaveLength(graph.nodeCount + 1);
    expect(offsets[graph.nodeCount]).toBe(graph.edgeCount * 2);
  });
});

describe('connectedComponents', () => {
  it('labels a connected graph as one component', () => {
    const graph = loadGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    });
    const { count, componentOf } = connectedComponents(graph);
    expect(count).toBe(1);
    expect(Array.from(componentOf)).toEqual([0, 0, 0]);
  });

  it('separates disjoint subgraphs', () => {
    const graph = loadGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'c', target: 'd' },
      ],
    });
    const { count, componentOf } = connectedComponents(graph);
    expect(count).toBe(2);
    expect(componentOf[0]).toBe(componentOf[1]);
    expect(componentOf[2]).toBe(componentOf[3]);
    expect(componentOf[0]).not.toBe(componentOf[2]);
  });

  it('treats every isolated node as its own component', () => {
    const graph = loadGraph({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [] });
    expect(connectedComponents(graph).count).toBe(3);
  });

  it('handles a long path without exhausting the stack', () => {
    const size = 15_000;
    const nodes = Array.from({ length: size }, (_, i) => ({ id: `n${i}` }));
    const edges = Array.from({ length: size - 1 }, (_, i) => ({
      source: `n${i}`,
      target: `n${i + 1}`,
    }));
    const graph = loadGraph({ nodes, edges });
    const { count } = connectedComponents(graph);
    expect(count).toBe(1);
  });

  it('numbers components by lowest member index, so numbering is stable', () => {
    const graph = loadGraph({
      nodes: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
      edges: [{ source: 'y', target: 'z' }],
    });
    const { componentOf } = connectedComponents(graph);
    expect(componentOf[0]).toBe(0);
    expect(componentOf[1]).toBe(1);
    expect(componentOf[2]).toBe(1);
  });
});
