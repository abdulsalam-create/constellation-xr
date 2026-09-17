# Constellation XR

**Explore force-directed graphs from inside them.** A WebXR graph explorer that
runs a Barnes–Hut N-body layout in a Web Worker, renders the whole graph in two
draw calls, and works in a headset or in a plain browser tab.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)



---

## Why this exists

A large graph drawn on a flat screen is a hairball. Edge crossings that do not
exist in the data appear anyway, clusters overlap, and panning loses your place.
In three dimensions with stereo depth and head tracking, most of that goes away:
you read cluster structure by moving your head, and you follow an edge by
walking along it.

The interesting part is not the VR. It is that a force-directed layout is an
N-body problem, an N-body problem is `O(n²)`, and a headset renders at 72–120 Hz
  roughly 11 ms per frame at 90 Hz   before the compositor starts reprojecting
and the user starts feeling ill.

Measured on a modest cloud container (Node 22, single thread, 40 steps after
warm-up, scale-free graphs with mean degree 6):

| nodes | edges  | ms per simulation step |
| ----- | ------ | ---------------------- |
| 1,000 | 2,962  | 3.9                    |
| 2,000 | 5,958  | 8.9                    |
| 2,500 | 7,455  | 11.4                   |
| 5,000 | 14,948 | 26.2                   |

Isolating the repulsion term at 5,000 nodes, against the exact `O(n²)` solve in
the same file: **19.0 ms for Barnes–Hut versus 209.9 ms brute force, an 11×
speedup.** That is the whole point of the octree, and it is what moves the
interactive ceiling from a few hundred nodes to a few thousand.

Two honest caveats. First, a single step fits the 11 ms frame budget up to
roughly 2,500 nodes on this hardware, not 5,000   and a standalone headset CPU
is slower than this container, not faster. Second, it does not actually have to
fit: the simulation runs in a Web Worker, so beyond that point the layout
converges over more wall-clock time while the render thread keeps its frame rate.
What you lose past ~2,500 nodes is settling speed, not smoothness.

## How it works

```
┌─────────────────────────┐        positions (transferred)        ┌──────────────────────┐
│  Layout worker          │ ────────────────────────────────────▶ │  Main thread         │
│                         │                                       │                      │
│  Barnes–Hut octree      │ ◀──────────────────────────────────── │  InstancedMesh nodes │
│  Springs + gravity      │        pin / unpin / reheat           │  LineSegments edges  │
│  Semi-implicit Euler    │                                       │  WebXR session       │
└─────────────────────────┘                                       └──────────────────────┘
```

**Barnes–Hut approximation.** Nodes are inserted into an octree; a cell of width
`s` seen from distance `d` is collapsed to its centre of mass whenever
`s / d < θ`. That takes the repulsion term from `O(n²)` to `O(n log n)`. The tree
is a struct-of-arrays over a growable pool with per-leaf linked lists, so
rebuilding it every step allocates nothing after warm-up   a GC pause is a
dropped frame, and a dropped frame in a headset is nausea. Centres of mass are
computed in a single reverse sweep over the cell pool, exploiting the fact that a
child always has a higher pool index than its parent, so no recursion and no
second tree walk are needed.

**Off the render thread.** The simulation runs in a Web Worker and hands
positions across as a _transferred_ `Float32Array`, which the main thread hands
straight back on the next tick. The two threads pass one allocation back and
forth for the lifetime of the page. A heavy graph slows the layout down without
ever stalling the compositor.

**Two draw calls.** All nodes are one `InstancedMesh` with per-instance colour;
all edges are one `LineSegments` over a buffer rewritten in place. Instance
matrices are written directly into the backing array rather than through
`Matrix4`/`Object3D`, because at a few thousand nodes the temporary-object churn
of the idiomatic path is measurable.

**Comfort by default.** Locomotion is teleport plus snap turn, not smooth
movement. Smooth locomotion induces motion sickness in a substantial minority of
people, so the comfortable option is the only option rather than a setting buried
in a menu. The teleport arc is real ballistics, so the landing point is
predictable, and teleporting moves the _player rig_ with the head's offset inside
the play space subtracted   otherwise a user standing in the corner of their room
arrives somewhere other than where they aimed.

**Aim assist that scales with distance.** Controller picking scores candidates by
_angular_ offset from the pointer ray, not by distance to it. A distance
threshold makes far nodes progressively harder to hit, because the same hand
wobble sweeps a wider arc further out. Angular scoring makes selection feel the
same at arm's length and across the room.

## Using it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 198 unit tests
npm run build      # production bundle into dist/
```

WebXR requires a secure context. `npm run dev` on `localhost` counts as one; to
test on a headset over the network, serve the build over HTTPS.

| Input                | Desktop | VR                         |
| -------------------- | ------- | -------------------------- |
| Orbit / look         | drag    | head tracking              |
| Zoom                 | scroll  |                            |
| Select a node        | click   | trigger                    |
| Grab and drag a node |         | grip                       |
| Move                 |         | trigger (aim at the floor) |
| Turn                 | drag    | thumbstick, 30° snap       |

### Loading your own graph

Drop a JSON file onto the page. The format is deliberately plain:

```json
{
  "name": "My dependency graph",
  "nodes": [
    { "id": "app", "label": "app", "group": "runtime" },
    { "id": "lib", "group": "runtime", "weight": 0.8 }
  ],
  "edges": [{ "source": "app", "target": "lib", "weight": 1 }]
}
```

`label`, `group` and `weight` are optional. Validation is strict and reports a
precise path   `edges[12].target: references unknown node "ghost"`   because a
dropped file is untrusted input and the failure you want is a message, not a
blank screen. Self-loops and duplicate edges are dropped; neither contributes
anything to the layout and both cost a spring evaluation every step.

## Testing

The whole simulation core is free of Three.js, the DOM and WebXR, which is what
makes it testable in plain Node. Two tests are worth calling out:

- **Barnes–Hut is checked against an exact `O(n²)` oracle.** At `θ = 0` no cell
  ever satisfies the opening criterion, so the traversal must descend to every
  leaf and the result must match the brute-force solve to float precision. The
  suite also asserts that error decreases _monotonically_ as θ tightens.
- **Coincident bodies.** Two nodes at the same coordinate have a separation
  vector of `(0, 0, 0)`, so softening keeps the force finite but leaves it
  pointing nowhere and the nodes stay welded together forever. The substitute
  displacement is deterministic (layouts stay reproducible) _and_ antisymmetric
  in the index pair   if it were not, every coincident pair would leak momentum
  and the whole graph would slowly drift off into space. Both properties have
  tests.

```
Test Files  8 passed (8)
     Tests  198 passed (198)
Coverage    97% statements, 99% functions
```

Coverage is scoped to `src/core/**`   the simulation, which is where the
algorithms that can be wrong live. The renderer, the worker, the XR input layer
and `main.ts` are not unit tested: they need a WebGL context and a headset, and
a mocked `XRSession` would test the mock. That is a real gap, not an oversight.

## Project layout

```
src/
  core/        simulation: octree, layout, picking, ballistics, graph, palette
  worker/      layout worker and its message protocol
  render/      Three.js scene and the instanced graph renderer
  xr/          session input, controllers, teleport and snap-turn locomotion
  ui/          HUD, desktop orbit controls
  data/        dataset loading and drag-and-drop
tests/         unit tests for everything in core/
```

## Known limitations

- **Edge bundling.** Above roughly 20,000 edges the line soup stops being
  readable regardless of layout quality. Hierarchical edge bundling would help
  and is not implemented.
- **No persistence.** Node positions are recomputed on every load. A settled
  layout could be cached, which would matter for large graphs.
- **Node capacity.** 20,000 nodes and 80,000 edges are enforced as hard limits.
  Beyond that the layout stops being interactive on standalone hardware; a
  GPU-side solve would be the way past it.
- **Labels.** Node labels are shown in the HUD, not drawn in the scene. In-world
  text at this instance count needs an SDF atlas, which is its own project.
- **Hand tracking** is requested as an optional feature and pinch gestures work
  through the standard select events, but there is no gesture vocabulary beyond
  pinch, and there is no haptic feedback on selection.
- **The bundled demo is small.** The sample dataset is 559 nodes, so the live
  demo does not exercise the several-thousand-node case the timings above
  describe. Drop in a larger graph to see that.

## References

- Barnes, J. & Hut, P. (1986). [A hierarchical O(N log N) force-calculation algorithm](https://www.nature.com/articles/324446a0). _Nature_ 324, 446–449.
- Fruchterman, T. & Reingold, E. (1991). Graph drawing by force-directed placement. _Software: Practice and Experience_ 21(11).
- Ottosson, B. (2020). [A perceptual color space for image processing](https://bottosson.github.io/posts/oklab/)   the OKLCH basis used for categorical node colours.
- [WebXR Device API](https://www.w3.org/TR/webxr/)   W3C.

## License

MIT   see [LICENSE](LICENSE).
