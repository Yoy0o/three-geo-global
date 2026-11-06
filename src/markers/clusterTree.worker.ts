/**
 * Builds point cluster trees off the main thread (`buildClusterTree` takes
 * ~0.2 s per 100k points). No three.js imports (AGENTS.md §3.6); the result's
 * typed arrays are transferred back.
 */
import { buildClusterTree, type ClusterTreeInput, type ClusterTreeOptions } from './clusterTree';

interface Request {
  id: number;
  input: ClusterTreeInput;
  options: ClusterTreeOptions;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, input, options } = event.data;
  const tree = buildClusterTree(input, options);
  const transfer = [tree.seed, tree.count, tree.zoom, tree.childStart, tree.children, tree.radius, tree.minDistance, tree.maxDistance, tree.roots].map(
    (a) => a.buffer as ArrayBuffer,
  );
  (self as unknown as Worker).postMessage({ id, tree }, transfer);
};
