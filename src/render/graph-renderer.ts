/**
 * Three.js rendering of the node cloud and edge set.
 *
 * Two objects draw the entire graph, regardless of its size:
 *
 * - Nodes: one `InstancedMesh` with per-instance colour. A separate `Mesh` per
 *   node would mean one draw call each, and a few thousand draw calls per eye is
 *   already over budget on standalone hardware.
 * - Edges: one `LineSegments` over a single position buffer, rewritten in place
 *   each frame from the node positions.
 *
 * Nothing here allocates per frame. The instance matrix is written directly into
 * the underlying array rather than going through `Matrix4`/`Object3D`, because at
 * 5,000 nodes the temporary-object churn of the idiomatic path is measurable.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  MeshStandardMaterial,
  type Object3D,
} from 'three';
import { DIM_FACTOR, SELECTION_COLOUR, buildPalette } from '../core/palette.js';

export interface RendererGraph {
  nodeCount: number;
  edgeCount: number;
  edges: Uint32Array;
  groupOf: Uint16Array;
  weights: Float32Array;
  groupNames: string[];
}

/** Node radius in world units, before the per-node weight multiplier. */
const BASE_RADIUS = 0.035;
const MAX_RADIUS_MULTIPLIER = 2.6;

export class GraphRenderer {
  readonly root = new Group();
  readonly nodes: InstancedMesh;
  readonly edges: LineSegments;

  /** Per-node world radius, kept for the picker. */
  readonly radii: Float32Array;

  private readonly graph: RendererGraph;
  private readonly palette: Float32Array;
  private readonly edgePositions: Float32Array;
  private readonly baseColours: Float32Array;
  private selected = -1;
  private neighbourFlags: Uint8Array;

  constructor(graph: RendererGraph) {
    this.graph = graph;
    this.palette = buildPalette(Math.max(1, graph.groupNames.length));
    this.radii = new Float32Array(graph.nodeCount);
    this.baseColours = new Float32Array(graph.nodeCount * 3);
    this.neighbourFlags = new Uint8Array(graph.nodeCount);

    // An icosahedron at detail 1 is 80 triangles and reads as a sphere at the
    // sizes nodes are actually drawn; a UV sphere costs several times that for
    // no visible gain once instanced thousands of times.
    const geometry = new IcosahedronGeometry(1, 1);
    const material = new MeshStandardMaterial({
      roughness: 0.42,
      metalness: 0.05,
      // Instance colours are authored in linear space by the palette, so no
      // colour-space conversion happens on upload.
      vertexColors: true,
    });

    this.nodes = new InstancedMesh(geometry, material, Math.max(1, graph.nodeCount));
    this.nodes.instanceMatrix.setUsage(DynamicDrawUsage);
    this.nodes.count = graph.nodeCount;
    this.nodes.frustumCulled = false; // positions change every frame
    this.nodes.castShadow = false;

    for (let i = 0; i < graph.nodeCount; i++) {
      this.radii[i] = BASE_RADIUS * (1 + graph.weights[i]! * (MAX_RADIUS_MULTIPLIER - 1));
      const group = graph.groupOf[i]! % Math.max(1, graph.groupNames.length);
      this.baseColours[i * 3] = this.palette[group * 3]!;
      this.baseColours[i * 3 + 1] = this.palette[group * 3 + 1]!;
      this.baseColours[i * 3 + 2] = this.palette[group * 3 + 2]!;
    }
    // Must be an InstancedBufferAttribute, not a plain BufferAttribute: the
    // renderer reads `meshPerAttribute` off it to decide the divisor, and a
    // plain attribute silently applies one colour to the whole mesh.
    const instanceColour = new InstancedBufferAttribute(Float32Array.from(this.baseColours), 3);
    instanceColour.setUsage(DynamicDrawUsage);
    this.nodes.instanceColor = instanceColour;

    this.edgePositions = new Float32Array(Math.max(1, graph.edgeCount) * 6);
    const edgeGeometry = new BufferGeometry();
    const attribute = new BufferAttribute(this.edgePositions, 3);
    attribute.setUsage(DynamicDrawUsage);
    edgeGeometry.setAttribute('position', attribute);
    edgeGeometry.setDrawRange(0, graph.edgeCount * 2);
    this.edges = new LineSegments(
      edgeGeometry,
      new LineBasicMaterial({ color: 0x8ea3c4, transparent: true, opacity: 0.22 }),
    );
    this.edges.frustumCulled = false;

    this.root.add(this.edges);
    this.root.add(this.nodes);
  }

  /** Rewrite instance transforms and the edge buffer from new positions. */
  update(positions: Float32Array): void {
    const array = this.nodes.instanceMatrix.array as Float32Array;
    const count = this.graph.nodeCount;

    for (let i = 0; i < count; i++) {
      const o = i * 16;
      const r = this.radii[i]!;
      // Column-major scale-and-translate. The rotation block stays identity and
      // the buffer starts zeroed, so only seven of the sixteen entries are ever
      // written: the three diagonal scales, the three translations, and w.
      array[o] = r;
      array[o + 5] = r;
      array[o + 10] = r;
      array[o + 12] = positions[i * 3]!;
      array[o + 13] = positions[i * 3 + 1]!;
      array[o + 14] = positions[i * 3 + 2]!;
      array[o + 15] = 1;
    }
    this.nodes.instanceMatrix.needsUpdate = true;

    const { edges, edgeCount } = this.graph;
    for (let e = 0; e < edgeCount; e++) {
      const a = edges[e * 2]! * 3;
      const b = edges[e * 2 + 1]! * 3;
      const o = e * 6;
      this.edgePositions[o] = positions[a]!;
      this.edgePositions[o + 1] = positions[a + 1]!;
      this.edgePositions[o + 2] = positions[a + 2]!;
      this.edgePositions[o + 3] = positions[b]!;
      this.edgePositions[o + 4] = positions[b + 1]!;
      this.edgePositions[o + 5] = positions[b + 2]!;
    }
    const attribute = this.edges.geometry.getAttribute('position');
    attribute.needsUpdate = true;
  }

  /**
   * Highlight one node and its neighbours, dimming everything else.
   *
   * Dimming rather than hiding: a graph with the unselected nodes removed loses
   * the context that made the selection worth looking at.
   */
  select(index: number, neighbours: Uint8Array | null): void {
    if (this.selected === index) return;
    this.selected = index;
    const colour = this.nodes.instanceColor;
    if (!colour) return;
    const target = colour.array as Float32Array;
    this.neighbourFlags = neighbours ?? new Uint8Array(this.graph.nodeCount);

    for (let i = 0; i < this.graph.nodeCount; i++) {
      const dim = index >= 0 && i !== index && this.neighbourFlags[i] !== 1;
      const factor = dim ? DIM_FACTOR : 1;
      if (i === index) {
        target[i * 3] = SELECTION_COLOUR[0];
        target[i * 3 + 1] = SELECTION_COLOUR[1];
        target[i * 3 + 2] = SELECTION_COLOUR[2];
      } else {
        target[i * 3] = this.baseColours[i * 3]! * factor;
        target[i * 3 + 1] = this.baseColours[i * 3 + 1]! * factor;
        target[i * 3 + 2] = this.baseColours[i * 3 + 2]! * factor;
      }
    }
    colour.needsUpdate = true;
    const material = this.edges.material as LineBasicMaterial;
    material.opacity = index >= 0 ? 0.1 : 0.22;
  }

  asObject3D(): Object3D {
    return this.root;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.clear();
    this.nodes.dispose();
    this.nodes.geometry.dispose();
    (this.nodes.material as MeshStandardMaterial).dispose();
    this.edges.geometry.dispose();
    (this.edges.material as LineBasicMaterial).dispose();
  }
}
