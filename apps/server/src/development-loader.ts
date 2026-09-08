/** Development only: workspace packages export TypeScript sources. Packaged
 * distributions must use their own compiled dependency graph, not this loader. */
export { register } from "tsx/esm/api";
