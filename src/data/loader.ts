/**
 * Dataset loading.
 *
 * Two sources: a bundled sample, and whatever the user drops onto the page. The
 * drop path is the reason `parseGraphInput` is strict — a dropped file is
 * untrusted, and the failure the user should see is "edges[12].target references
 * unknown node", not a blank screen.
 */

import { parseGraphInput } from '../core/graph.js';
import type { GraphInput } from '../core/types.js';

/** Fetch and validate a graph document from a URL. */
export async function fetchGraph(url: string): Promise<GraphInput> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  }
  return parseGraphInput(await response.json());
}

/** Read and validate a graph document from a dropped or picked file. */
export async function readGraphFile(file: File): Promise<GraphInput> {
  const MAX_BYTES = 32 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    throw new Error(`${file.name} is ${(file.size / 1e6).toFixed(1)} MB; the limit is 32 MB`);
  }
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file.name} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  return parseGraphInput(parsed);
}

/**
 * Wire up drag-and-drop on an element.
 *
 * `dragover` must be cancelled or the browser navigates away from the page to
 * display the dropped file, which looks exactly like a crash.
 */
export function enableDrop(
  element: HTMLElement,
  onGraph: (graph: GraphInput, name: string) => void,
  onError: (message: string) => void,
): () => void {
  const onDragOver = (event: DragEvent): void => {
    event.preventDefault();
    element.setAttribute('data-dragging', 'true');
  };
  const onDragLeave = (): void => element.removeAttribute('data-dragging');
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    element.removeAttribute('data-dragging');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    void readGraphFile(file).then(
      (graph) => onGraph(graph, file.name),
      (error: unknown) => onError(error instanceof Error ? error.message : String(error)),
    );
  };

  element.addEventListener('dragover', onDragOver);
  element.addEventListener('dragleave', onDragLeave);
  element.addEventListener('drop', onDrop);

  return () => {
    element.removeEventListener('dragover', onDragOver);
    element.removeEventListener('dragleave', onDragLeave);
    element.removeEventListener('drop', onDrop);
  };
}
