declare module "*?nodeWorker" {
    const worker: any;
    export default worker;
}
declare module 'vite-plugin-node-worker' {
    import { Plugin } from 'vite';
    function workerPlugin(): Plugin;
    export default workerPlugin;
}